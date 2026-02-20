const socket = io();

// DOM Elements
const terminalOutput = document.getElementById('terminal-output');
const aiOutput = document.getElementById('ai-output');
const commandInput = document.getElementById('command-input');
const aiInput = document.getElementById('ai-input');
const connectionStatus = document.getElementById('connection-status');
const sshStatus = document.getElementById('ssh-status');
const sshForm = document.getElementById('ssh-form');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const ollamaUrlInput = document.getElementById('ollama-url');
const modelSelect = document.getElementById('model-select');
const ollamaStatus = document.getElementById('ollama-status');
const themeSelect = document.getElementById('theme-select');

// Global state
let currentOllamaUrl = ollamaUrlInput.value;
let currentModel = 'llama2';
let aiName = 'Assistant';
let aiRole = 'Linux Expert';
let autoExecute = true;
let currentTheme = 'dark';

// conversation history - stores all interactions for context
let conversationHistory = [];
let maxHistoryMessages = 10; // Keep last 10 messages for context

// apply chosen theme by toggling class on document body
function applyTheme(theme) {
    currentTheme = theme || 'dark';
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    document.documentElement.classList.add(`theme-${currentTheme}`);
    if (themeSelect) {
        themeSelect.value = currentTheme;
    }
}


// Command history for arrow key navigation
let commandHistory = [];
let historyPosition = -1;
let currentCommand = '';

// Settings storage functions
const SettingsManager = {
    // Save all settings to server
    async saveAllSettings() {
        const settings = {
            ssh: {
                host: document.getElementById('ssh-host').value,
                port: document.getElementById('ssh-port').value,
                username: document.getElementById('ssh-username').value,
                password: document.getElementById('ssh-password').value,
                keyfile: document.getElementById('ssh-keyfile').value
            },
            ai: {
                name: document.getElementById('ai-name').value,
                role: document.getElementById('ai-role').value,
                ollamaUrl: document.getElementById('ollama-url').value,
                autoExecute: document.getElementById('auto-execute').checked,
                model: currentModel,
                theme: currentTheme
            }
        };
        
        try {
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            });
            const data = await response.json();
            console.log('[Settings] Save response:', data);
            return data.success;
        } catch (e) {
            console.error('[Settings] Error saving:', e);
            return false;
        }
    },
    
    // Load all settings from server
    async loadAllSettings() {
        try {
            const response = await fetch('/api/settings');
            const data = await response.json();
            
            if (data.success && data.settings) {
                const settings = data.settings;
                
                // Load SSH settings
                if (settings.ssh) {
                    document.getElementById('ssh-host').value = settings.ssh.host || '';
                    document.getElementById('ssh-port').value = settings.ssh.port || '22';
                    document.getElementById('ssh-username').value = settings.ssh.username || '';
                    document.getElementById('ssh-password').value = settings.ssh.password || '';
                    document.getElementById('ssh-keyfile').value = settings.ssh.keyfile || '';
                }
                
                // Load AI settings
                if (settings.ai) {
                    document.getElementById('ai-name').value = settings.ai.name || 'Assistant';
                    document.getElementById('ai-role').value = settings.ai.role || 'Linux Expert';
                    document.getElementById('ollama-url').value = settings.ai.ollamaUrl || 'http://localhost:11434';
                    document.getElementById('auto-execute').checked = settings.ai.autoExecute !== false;
                    if (settings.ai.model) {
                        currentModel = settings.ai.model;
                    }
                    if (settings.ai.theme) {
                        applyTheme(settings.ai.theme);
                    }
                }
                
                console.log('[Settings] Loaded from server');
                return true;
            }
        } catch (e) {
            console.error('[Settings] Error loading:', e);
        }
        return false;
    },
    
    // Legacy methods for compatibility
    saveSshSettings() {
        this.saveAllSettings();
    },
    
    loadSshSettings() {
        // Handled by loadAllSettings
    },
    
    saveAiSettings() {
        this.saveAllSettings();
    },
    
    loadAiSettings() {
        // Handled by loadAllSettings
    },
    
    clearAllSettings() {
        // Clear on server
        this.saveAllSettings({ ssh: {}, ai: {} });
        console.log('[Settings] All settings cleared');
    }
};

// Save current settings and optionally save as host
async function saveSettings() {
    const success = await SettingsManager.saveAllSettings();
    if (success) {
        addTerminalOutput('System', 'Settings saved successfully', 'success');
        
        // If host name is provided, also save as a host
        const hostName = document.getElementById('host-name').value.trim();
        if (hostName) {
            await saveCurrentHostSilent();
        }
    } else {
        addTerminalOutput('Error', 'Failed to save settings', 'error');
    }
}

// Tab switching
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        btn.classList.add('active');
        const tabName = btn.getAttribute('data-tab');
        document.getElementById(tabName).classList.add('active');
        
        if (tabName === 'ai') {
            aiInput.focus();
        } else {
            commandInput.focus();
        }
    });
});

// Socket.IO Events
socket.on('connection_response', (data) => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.remove('disconnected');
    connectionStatus.classList.add('connected');
    addTerminalOutput('System', 'Connected to AI Terminal', 'success');
    // Fetch server-side conversation history for this session
    socket.emit('get_history');
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('connected');
    connectionStatus.classList.add('disconnected');
    addTerminalOutput('System', 'Disconnected from server', 'error');
});

socket.on('ssh_status', (data) => {
    if (data.connected) {
        sshStatus.textContent = 'SSH: Connected';
        sshStatus.classList.remove('disconnected');
        sshStatus.classList.add('connected');
        addTerminalOutput('SSH', `Connected to ${document.getElementById('ssh-host').value}`, 'success');
        
        // Auto-save the SSH settings to general settings
        SettingsManager.saveAllSettings();
        
        // Also auto-save to hosts list if a name is provided
        const hostName = document.getElementById('host-name').value.trim();
        if (hostName) {
            saveCurrentHostSilent();
        }
    } else {
        sshStatus.textContent = 'SSH: Not Connected';
        sshStatus.classList.remove('connected');
        sshStatus.classList.add('disconnected');
        addTerminalOutput('SSH', `Connection failed: ${data.message}`, 'error');
    }
});

socket.on('command_output', (data) => {
    if (data.success) {
        addTerminalOutput('Output', data.output, 'success');
    } else {
        addTerminalOutput('Error', data.output, 'error');
    }
});

socket.on('ai_response', (data) => {
    // remove any thinking indicator when we get a response
    removeAIThinking();
    if (data.success) {
        // If server provided a canonical history, sync it and render
        if (data.history && Array.isArray(data.history)) {
            conversationHistory = data.history.slice();
            renderHistory();
        } else {
            addAIMessage('assistant', data.response);
            conversationHistory.push({ role: 'assistant', content: data.response, timestamp: new Date().toISOString() });
        }
    } else {
        addAIMessage('assistant', `Error: ${data.error}`, 'error');
        conversationHistory.push({ role: 'assistant', content: `Error: ${data.error}`, timestamp: new Date().toISOString(), isError: true });
    }
});

socket.on('generated_command', (data) => {
    // remove thinking indicator when a generated command arrives
    removeAIThinking();
    if (data.success) {
        const aiNameDisplay = document.getElementById('ai-name').value;
        addTerminalOutput(aiNameDisplay, `Generated command: ${data.command}`, 'ai');
        
        // Add AI response to history
        conversationHistory.push({
            role: 'assistant',
            content: `Generated command: ${data.command}`,
            timestamp: new Date().toISOString()
        });
        
        if (autoExecute && data.auto_run) {
            // Auto-execute the command
            addTerminalOutput('System', 'Executing command...', 'success');
            socket.emit('ssh_command', { command: data.command });
        } else {
            // Just show in input for manual execution
            commandInput.value = data.command;
            commandInput.focus();
        }
    } else {
        addTerminalOutput('Error', data.error, 'error');
    }
});

socket.on('ai_command_result', (data) => {
    // remove thinking indicator when command result arrives
    removeAIThinking();
    if (data.success) {
        const aiNameDisplay = document.getElementById('ai-name').value || 'Assistant';
        addTerminalOutput(aiNameDisplay, data.output, data.type || 'success');
        
        // If server provided history, sync and render; otherwise append
        if (data.history && Array.isArray(data.history)) {
            conversationHistory = data.history.slice();
            renderHistory();
        } else {
            conversationHistory.push({
                role: 'assistant',
                content: data.output,
                timestamp: new Date().toISOString()
            });
        }
    } else {
        addTerminalOutput('Error', data.error || 'Command execution failed', 'error');
        
        // Add error to history
        conversationHistory.push({
            role: 'assistant',
            content: data.error || 'Command execution failed',
            timestamp: new Date().toISOString(),
            isError: true
        });
    }
});

// Event Listeners

if (themeSelect) {
    themeSelect.addEventListener('change', () => {
        applyTheme(themeSelect.value);
        SettingsManager.saveAllSettings();
    });
}

sshForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const host = document.getElementById('ssh-host').value.trim();
    const port = parseInt(document.getElementById('ssh-port').value);
    const username = document.getElementById('ssh-username').value.trim();
    const password = document.getElementById('ssh-password').value;
    const keyFile = document.getElementById('ssh-keyfile').value;
    
    // Save SSH settings before connecting
    SettingsManager.saveSshSettings();
    
    // Auto-generate host name if not provided
    const hostName = document.getElementById('host-name').value.trim();
    if (!hostName && host) {
        document.getElementById('host-name').value = `${username}@${host}`;
    }
    
    // Console log for debugging
    console.log('[SSH Form] Values:', { host, port, username, password: password ? '***' : '', keyFile });
    
    if (!host) {
        addTerminalOutput('Error', 'Please enter a host address', 'error');
        console.error('[SSH Form] Missing host');
        return;
    }
    
    if (!username) {
        addTerminalOutput('Error', 'Please enter a username', 'error');
        console.error('[SSH Form] Missing username');
        return;
    }
    
    addTerminalOutput('System', `Connecting to ${username}@${host}:${port}...`, 'command');
    console.log('[SSH Form] Emitting ssh_connect with:', { host, port, username });
    
    socket.emit('ssh_connect', {
        host,
        port,
        username,
        password: password || undefined,
        key_file: keyFile || undefined
    });
});

// Arrow key navigation for command history
commandInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (commandHistory.length === 0) return;
        
        // Save current input if we're starting to navigate
        if (historyPosition === -1) {
            currentCommand = commandInput.value;
        }
        
        // Move up in history
        if (historyPosition < commandHistory.length - 1) {
            historyPosition++;
            commandInput.value = commandHistory[commandHistory.length - 1 - historyPosition];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyPosition === -1) return;
        
        // Move down in history
        historyPosition--;
        if (historyPosition === -1) {
            // Restore the command being typed
            commandInput.value = currentCommand;
        } else {
            commandInput.value = commandHistory[commandHistory.length - 1 - historyPosition];
        }
    }
});

commandInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const command = commandInput.value.trim();
        if (command) {
            addTerminalOutput('You', `$ ${command}`, 'command');
            
            // Add to command history (avoid duplicates of the last command)
            if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== command) {
                commandHistory.push(command);
            }
            
            // Reset history position
            historyPosition = -1;
            currentCommand = '';
            
            // Add to conversation history
            conversationHistory.push({
                role: 'user',
                content: command,
                timestamp: new Date().toISOString()
            });
            
            // Keep only last N messages for context
            if (conversationHistory.length > maxHistoryMessages) {
                conversationHistory = conversationHistory.slice(-maxHistoryMessages);
            }
            
            // Send to AI for interpretation and execution
            socket.emit('ai_execute_command', {
                request: command,
                url: currentOllamaUrl,
                model: currentModel,
                aiName: aiName,
                aiRole: aiRole,
                history: conversationHistory // Pass conversation history
            });

            // show thinking indicator in AI chat while AI is processing
            showAIThinking();
            
            commandInput.value = '';
        }
    }
});

aiInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const prompt = aiInput.value.trim();
        if (prompt) {
            addAIMessage('user', prompt);
            socket.emit('ollama_prompt', { 
                prompt,
                url: currentOllamaUrl,
                model: currentModel,
                history: conversationHistory.slice(-maxHistoryMessages)
            });
            // show thinking indicator in AI chat while waiting for response
            showAIThinking();
            aiInput.value = '';
        }
    }
});

// Functions
function handleSSHCommand(command) {
    socket.emit('ssh_command', { command });
}

function handleAICommandGeneration(description) {
    const prompt = description
        .replace(/^(help:|generate:)/i, '')
        .trim();
    socket.emit('ollama_command_generation', { 
        description: prompt,
        context: `You are ${aiName}, a ${aiRole}. Generate a shell command for the following task`,
        url: currentOllamaUrl,
        model: currentModel,
        auto_run: autoExecute
    });
}

function sendAIPrompt() {
    const prompt = aiInput.value.trim();
    if (prompt) {
        addAIMessage('user', prompt);
        socket.emit('ollama_prompt', { 
            prompt,
            history: conversationHistory.slice(-maxHistoryMessages)
        });
        aiInput.value = '';
    }
}

function addTerminalOutput(prefix, message, type = 'normal') {
    const line = document.createElement('div');
    line.className = `output-line ${type}`;
    
    if (prefix) {
        const prefixSpan = document.createElement('span');
        prefixSpan.style.color = '#8b949e';
        prefixSpan.textContent = `[${prefix}] `;
        line.appendChild(prefixSpan);
    }
    
    const messageSpan = document.createElement('span');
    // Preserve newlines by using pre-wrap white-space style
    messageSpan.style.whiteSpace = 'pre-wrap';
    messageSpan.textContent = message;
    line.appendChild(messageSpan);
    
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Convert inline Markdown-like formatting to HTML for AI messages
function formatInlineMarkdown(text) {
    const escaped = escapeHtml(text);
    return escaped
        // inline code: `code`
        .replace(/`([^`]+)`/g, '<span class="inline-code">$1</span>')
        // bold: **strong** or __strong__
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>');
}

function addAIMessage(role, content, type = 'normal', skipHistoryPush = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${role}`;

    const label = document.createElement('div');
    label.className = 'ai-label';
    if (role === 'user') {
        label.textContent = 'You';
    } else {
        const aiNameDisplay = document.getElementById('ai-name').value || 'AI Assistant';
        label.textContent = aiNameDisplay;
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = `ai-content ${type}`;

    // Track the message to client-side conversationHistory if not synced from server
    if (!skipHistoryPush) {
        if (role === 'user') {
            // If last history entry from server already equals this content, avoid duplicate
            const last = conversationHistory[conversationHistory.length - 1];
            if (!last || last.content !== content) {
                conversationHistory.push({ role: 'user', content: content, timestamp: new Date().toISOString() });
            }
        }
    }

    // Render content line-by-line, highlighting titles and rendering commands on a black background like a terminal
    if (typeof content === 'string') {
        const lines = content.split('\n');
        let inCodeBlock = false;
        let codeBuffer = [];

        // --- helpers for table detection/parsing ---
        function isTableSeparatorRow(line) {
            const cells = line.trim().replace(/^\||\|$/g, '').split('|');
            if (cells.length < 1) return false;
            return cells.every(cell => /^\s*:?-+:?\s*$/.test(cell));
        }
        function splitTableRow(line) {
            return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Handle fenced code blocks ```
            if (/^```/.test(line.trim())) {
                inCodeBlock = !inCodeBlock;
                if (!inCodeBlock) {
                    // closing - render buffered code
                    const pre = document.createElement('pre');
                    pre.className = 'ai-code-block';
                    const code = document.createElement('code');
                    code.textContent = codeBuffer.join('\n');
                    pre.appendChild(code);
                    contentDiv.appendChild(pre);
                    codeBuffer = [];
                }
                continue;
            }

            if (inCodeBlock) {
                codeBuffer.push(line);
                continue;
            }

            if (!line.trim()) {
                const br = document.createElement('div');
                br.innerHTML = '&nbsp;';
                contentDiv.appendChild(br);
                continue;
            }

            // Detect pipe-style Markdown table: header line contains '|' and next line is a separator row
            if (line.includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
                const headerCells = splitTableRow(line);
                const alignCells = splitTableRow(lines[i + 1]).map(s => {
                    const left = s.trim().startsWith(':');
                    const right = s.trim().endsWith(':');
                    if (left && right) return 'center';
                    if (right) return 'right';
                    return 'left';
                });

                // gather subsequent rows until a non-pipe line
                const dataRows = [];
                let j = i + 2;
                while (j < lines.length && lines[j].includes('|')) {
                    dataRows.push(splitTableRow(lines[j]));
                    j++;
                }

                // build responsive table DOM
                const wrap = document.createElement('div');
                wrap.className = 'ai-table-wrap';
                const table = document.createElement('table');
                table.className = 'ai-table';

                const thead = document.createElement('thead');
                const thr = document.createElement('tr');
                headerCells.forEach((cell, idx) => {
                    const th = document.createElement('th');
                    const align = alignCells[idx] || 'left';
                    th.className = `ai-table-cell ai-align-${align}`;
                    th.innerHTML = formatInlineMarkdown(cell);
                    thr.appendChild(th);
                });
                thead.appendChild(thr);
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                dataRows.forEach(rowCells => {
                    const tr = document.createElement('tr');
                    for (let k = 0; k < headerCells.length; k++) {
                        const td = document.createElement('td');
                        const text = rowCells[k] || '';
                        const align = alignCells[k] || 'left';
                        td.className = `ai-table-cell ai-align-${align}`;
                        td.innerHTML = formatInlineMarkdown(text);
                        tr.appendChild(td);
                    }
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                wrap.appendChild(table);
                contentDiv.appendChild(wrap);

                // skip processed table lines
                i = j - 1;
                continue;
            }

            // Horizontal rule (ATX/setext-like: ---, ***, ___)
            if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
                const hr = document.createElement('hr');
                hr.className = 'ai-hr';
                contentDiv.appendChild(hr);
                continue;
            }

            // ATX-style headings: #, ##, ### ... — render with semantic classes
            const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                const text = headingMatch[2].trim();
                const heading = document.createElement('div');
                heading.className = `ai-heading ai-h${level}`;
                heading.innerHTML = formatInlineMarkdown(text);
                contentDiv.appendChild(heading);
                continue;
            }

            // Commands indicated by lines starting with "$ " or "Generated command:" should be displayed on black background
            if (/^\$\s/.test(line) || /^Generated command:/i.test(line)) {
                let cmd = line.replace(/^\$\s?/, '').replace(/^Generated command:\s*/i, '');
                const pre = document.createElement('pre');
                pre.className = 'ai-command';
                pre.textContent = cmd;
                contentDiv.appendChild(pre);
                continue;
            }

            // Titles: simple heuristic - lines ending with ':' are treated as titles
            if (line.trim().endsWith(':')) {
                const title = document.createElement('div');
                title.className = 'ai-title';
                title.innerHTML = formatInlineMarkdown(line.trim());
                contentDiv.appendChild(title);
                continue;
            }

            // Normal paragraph - render inline formatting and escape HTML
            const p = document.createElement('div');
            p.innerHTML = formatInlineMarkdown(line);
            contentDiv.appendChild(p);
        }

        // flush any unterminated fenced code block
        if (inCodeBlock && codeBuffer.length) {
            const pre = document.createElement('pre');
            pre.className = 'ai-code-block';
            const code = document.createElement('code');
            code.textContent = codeBuffer.join('\n');
            pre.appendChild(code);
            contentDiv.appendChild(pre);
        }
    } else {
        // Fallback - non-string content
        const p = document.createElement('div');
        p.textContent = String(content);
        contentDiv.appendChild(p);
    }

    msgDiv.appendChild(label);
    msgDiv.appendChild(contentDiv);

    aiOutput.appendChild(msgDiv);
    // Scroll so the *start* of the new message is visible (user reads from the top of the reply)
    try {
        msgDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        aiOutput.scrollTop = aiOutput.scrollHeight;
    }
}

// Show / remove AI thinking indicator in AI chat
function showAIThinking() {
    // remove existing if present
    removeAIThinking();
    const msgDiv = document.createElement('div');
    msgDiv.className = 'ai-message assistant thinking';

    const label = document.createElement('div');
    label.className = 'ai-label';
    label.textContent = document.getElementById('ai-name').value || 'AI Assistant';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'ai-content';

    const wrap = document.createElement('div');
    wrap.className = 'ai-thinking-wrap';
    const dots = document.createElement('div');
    dots.className = 'ai-thinking';
    dots.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    wrap.appendChild(dots);
    const text = document.createElement('div');
    text.style.color = '#9fbfff';
    text.style.fontSize = '13px';
    text.textContent = 'Thinking...';
    wrap.appendChild(text);

    contentDiv.appendChild(wrap);
    msgDiv.appendChild(label);
    msgDiv.appendChild(contentDiv);

    aiOutput.appendChild(msgDiv);
    // Keep the thinking indicator visible at the *start* so the user sees the beginning of the upcoming answer
    try {
        msgDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        aiOutput.scrollTop = aiOutput.scrollHeight;
    }
}

function removeAIThinking() {
    const el = aiOutput.querySelector('.ai-message.thinking');
    if (el) el.remove();
}

// Render the full conversation history (clears and re-renders)
function renderHistory() {
    // Clear current messages
    aiOutput.innerHTML = '';
    if (!conversationHistory || conversationHistory.length === 0) return;
    conversationHistory.forEach(msg => {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        addAIMessage(role, msg.content, msg.isError ? 'error' : 'normal', true);
    });
    // After re-rendering history, show the *start* of the latest message (so reading begins at message top)
    const lastMsg = aiOutput.querySelector('.ai-message:last-child');
    if (lastMsg) {
        try { lastMsg.scrollIntoView({ behavior: 'auto', block: 'start' }); }
        catch (e) { aiOutput.scrollTop = aiOutput.scrollHeight; }
    } else {
        aiOutput.scrollTop = aiOutput.scrollHeight;
    }
}

// Handle server-sent history on initial fetch
socket.on('history', (data) => {
    if (data.success) {
        conversationHistory = data.history.slice();
        renderHistory();
    } else {
        console.error('Failed to fetch history:', data.error);
    }
});

function loadModels() {
    fetch('/api/ollama/models')
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const select = document.getElementById('model-select');
                select.innerHTML = '';
                data.models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    select.appendChild(option);
                });
                addTerminalOutput('System', 'Models loaded successfully', 'success');
            } else {
                addTerminalOutput('Error', `Failed to load models: ${data.error}`, 'error');
            }
        })
        .catch(err => {
            addTerminalOutput('Error', `Failed to fetch models: ${err}`, 'error');
        });
}

function fetchOllamaModels() {
    const ollamaUrl = ollamaUrlInput.value.trim();
    
    console.log('[Ollama] URL input value:', ollamaUrl);
    
    if (!ollamaUrl) {
        setOllamaStatus('Please enter an Ollama URL', 'error');
        console.error('[Ollama] Empty URL');
        return;
    }
    
    // Save Ollama URL setting
    currentOllamaUrl = ollamaUrl;
    SettingsManager.saveAiSettings();
    
    setOllamaStatus('Connecting to Ollama...', 'loading');
    console.log('[Ollama] Attempting connection to:', ollamaUrl);
    
    fetch('/api/ollama/connect', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ url: ollamaUrl })
    })
    .then(res => {
        console.log('[Ollama] Response status:', res.status);
        return res.json();
    })
    .then(data => {
        console.log('[Ollama] Response data:', data);
        if (data.success) {
            currentOllamaUrl = ollamaUrl;
            
            // Update model select
            modelSelect.innerHTML = '';
            if (data.models.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = 'No models available';
                modelSelect.appendChild(option);
                setOllamaStatus('Connected but no models found. Pull models in Ollama.', 'warning');
            } else {
                data.models.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    modelSelect.appendChild(option);
                });
                // Use saved model if available, otherwise use first model
                if (currentModel && data.models.includes(currentModel)) {
                    modelSelect.value = currentModel;
                } else {
                    modelSelect.value = data.models[0];
                    currentModel = data.models[0];
                }
                setOllamaStatus(`✓ ${data.message} (${data.models.length} models)`, 'success');
                addTerminalOutput('Ollama', data.message, 'success');
            }
        } else {
            setOllamaStatus(`✗ ${data.error}`, 'error');
            addTerminalOutput('Error', `Ollama connection failed: ${data.error}`, 'error');
        }
    })
    .catch(err => {
        setOllamaStatus(`✗ Connection error: ${err}`, 'error');
        addTerminalOutput('Error', `Failed to connect: ${err}`, 'error');
    });
}

function setOllamaStatus(message, status) {
    ollamaStatus.textContent = message;
    ollamaStatus.className = `ollama-status ${status}`;
}

// Event listener for model selection
modelSelect.addEventListener('change', (e) => {
    currentModel = e.target.value;
    if (currentModel) {
        addTerminalOutput('System', `Selected model: ${currentModel}`, 'success');
        SettingsManager.saveAiSettings();
    }
});

// Event listeners for AI configuration
document.getElementById('ai-name').addEventListener('change', (e) => {
    aiName = e.target.value || 'Assistant';
    addTerminalOutput('System', `AI name set to: ${aiName}`, 'success');
    SettingsManager.saveAiSettings();
});

document.getElementById('ai-role').addEventListener('change', (e) => {
    aiRole = e.target.value || 'Linux Expert';
    addTerminalOutput('System', `AI role set to: ${aiRole}`, 'success');
    SettingsManager.saveAiSettings();
});

document.getElementById('auto-execute').addEventListener('change', (e) => {
    autoExecute = e.target.checked;
    const status = autoExecute ? 'enabled' : 'disabled';
    addTerminalOutput('System', `Auto-execute commands ${status}`, 'success');
    SettingsManager.saveAiSettings();
});

// Initialize
window.addEventListener('load', async () => {
    // Load saved settings from server first
    await SettingsManager.loadAllSettings();
    
    // Update global variables from loaded settings
    currentOllamaUrl = document.getElementById('ollama-url').value;
    aiName = document.getElementById('ai-name').value;
    aiRole = document.getElementById('ai-role').value;
    autoExecute = document.getElementById('auto-execute').checked;
    
    // apply theme after settings loaded (defaults to dark)
    if (themeSelect) {
        applyTheme(themeSelect.value || currentTheme);
    }
    
    commandInput.focus();
    addTerminalOutput('System', 'AI Terminal Ready', 'success');
    addTerminalOutput('Help', 'Enter commands or describe what you want to do. AI will execute them for you.', 'normal');
    
    // Auto-load models on startup
    setTimeout(() => {
        fetchOllamaModels();
    }, 500);
    
    // Load saved hosts
    loadSavedHosts();
});

// Host Management Functions
async function loadSavedHosts() {
    try {
        const response = await fetch('/api/hosts');
        const data = await response.json();
        
        if (data.success) {
            const hostsSelect = document.getElementById('saved-hosts');
            hostsSelect.innerHTML = '<option value="">Select a saved host...</option>';
            
            data.hosts.forEach(host => {
                const option = document.createElement('option');
                option.value = host.name;
                option.textContent = host.name;
                option.dataset.host = JSON.stringify(host);
                hostsSelect.appendChild(option);
            });
        }
    } catch (e) {
        console.error('[Hosts] Error loading saved hosts:', e);
    }
}

function loadHostConfig(hostName) {
    if (!hostName) return;
    
    const hostsSelect = document.getElementById('saved-hosts');
    const selectedOption = hostsSelect.querySelector(`option[value="${hostName}"]`);
    
    if (selectedOption && selectedOption.dataset.host) {
        const host = JSON.parse(selectedOption.dataset.host);
        document.getElementById('host-name').value = host.name || '';
        document.getElementById('ssh-host').value = host.host || '';
        document.getElementById('ssh-port').value = host.port || '22';
        document.getElementById('ssh-username').value = host.username || '';
        document.getElementById('ssh-password').value = host.password || '';
        document.getElementById('ssh-keyfile').value = host.keyfile || '';
        
        addTerminalOutput('System', `Loaded host configuration: ${hostName}`, 'success');
    }
}

async function saveCurrentHost() {
    const hostName = document.getElementById('host-name').value.trim();
    
    if (!hostName) {
        addTerminalOutput('Error', 'Please enter a host name to save', 'error');
        return;
    }
    
    const hostData = {
        name: hostName,
        host: document.getElementById('ssh-host').value.trim(),
        port: document.getElementById('ssh-port').value,
        username: document.getElementById('ssh-username').value.trim(),
        password: document.getElementById('ssh-password').value,
        keyfile: document.getElementById('ssh-keyfile').value
    };
    
    try {
        const response = await fetch('/api/hosts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hostData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            addTerminalOutput('System', `Host "${hostName}" saved successfully`, 'success');
            await loadSavedHosts();
        } else {
            addTerminalOutput('Error', `Failed to save host: ${data.error}`, 'error');
        }
    } catch (e) {
        addTerminalOutput('Error', `Error saving host: ${e.message}`, 'error');
    }
}

async function saveCurrentHostSilent() {
    const hostName = document.getElementById('host-name').value.trim();
    
    if (!hostName) return;
    
    const hostData = {
        name: hostName,
        host: document.getElementById('ssh-host').value.trim(),
        port: document.getElementById('ssh-port').value,
        username: document.getElementById('ssh-username').value.trim(),
        password: document.getElementById('ssh-password').value,
        keyfile: document.getElementById('ssh-keyfile').value
    };
    
    try {
        const response = await fetch('/api/hosts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hostData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            await loadSavedHosts();
        }
    } catch (e) {
        console.error('[Hosts] Error auto-saving host:', e);
    }
}

async function deleteCurrentHost() {
    const hostName = document.getElementById('host-name').value.trim();
    
    if (!hostName) {
        addTerminalOutput('Error', 'Please select or enter a host name to delete', 'error');
        return;
    }
    
    if (!confirm(`Are you sure you want to delete the host "${hostName}"?`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/hosts/${encodeURIComponent(hostName)}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            addTerminalOutput('System', `Host "${hostName}" deleted successfully`, 'success');
            
            // Clear the form
            document.getElementById('host-name').value = '';
            document.getElementById('ssh-host').value = '';
            document.getElementById('ssh-port').value = '22';
            document.getElementById('ssh-username').value = '';
            document.getElementById('ssh-password').value = '';
            document.getElementById('ssh-keyfile').value = '';
            
            await loadSavedHosts();
        } else {
            addTerminalOutput('Error', `Failed to delete host: ${data.error}`, 'error');
        }
    } catch (e) {
        addTerminalOutput('Error', `Error deleting host: ${e.message}`, 'error');
    }
}

