import os
import json
import paramiko
import requests
from flask import Flask, render_template, request, jsonify

# bring encryption routines in from utils
from utils import (
    decrypt_settings,
    encrypt_settings,
)
from flask_socketio import SocketIO, emit, join_room, leave_room
from threading import Thread
import time

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'your-secret-key-change-in-production')
socketio = SocketIO(app, cors_allowed_origins="*")

# Configuration
OLLAMA_HOST = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'llama2')
SETTINGS_FILE = os.path.join(os.path.dirname(__file__), 'user_settings.json')

# Store SSH connections and Ollama settings
ssh_connections = {}
ollama_settings = {}
saved_hosts = {}  # Store saved SSH hosts
current_directories = {}  # Track current directory per session
chat_histories = {}      # messages for AI chat tab per session
terminal_histories = {}  # messages used for terminal AI assistance per session

# Settings management functions

def add_to_history(sid, role, content, chat=True, max_messages=100):
    """Add a message to either chat or terminal history for a session.

    ``chat`` determines which store to use.  Chat history feeds the AI Chat
    tab; terminal history is only used when interpreting/executing commands
    entered in the terminal pane.
    """
    if not sid:
        return
    store = chat_histories if chat else terminal_histories
    hist = store.setdefault(sid, [])
    hist.append({'role': role, 'content': content})
    if len(hist) > max_messages:
        store[sid] = hist[-max_messages:]


def format_history_for_prompt(sid, last_n=10, chat=True):
    """Format the last_n messages for inclusion in a prompt.

    ``chat`` selects which history store to use.  Typically terminal commands use
    ``chat=False``; AI chat interactions use ``chat=True``.
    """
    store = chat_histories if chat else terminal_histories
    hist = store.get(sid, [])[-last_n:]
    if not hist:
        return ""
    formatted = "\nPrevious conversation context:\n"
    for msg in hist:
        role = msg.get('role', 'user')
        label = 'Assistant' if role == 'assistant' else 'User'
        formatted += f"{label}: {msg.get('content', '')}\n"
    return formatted
def load_settings_from_file():
    """Load settings from JSON file and decrypt any stored passwords.

    The data on disk is kept encrypted; callers always receive a dictionary
    containing plaintext values.  ``decrypt_settings`` is a no-op if the
    environmental key is not available or the stored values were already
    plaintext (e.g. during initial development).
    """
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r') as f:
                data = json.load(f)
                return decrypt_settings(data)
        except Exception as e:
            # print(f'[Settings] Error loading from file: {e}')
            return {}
    return {}

def save_settings_to_file(settings):
    """Save settings to JSON file, encrypting passwords in the process."""
    try:
        # perform a deep copy so nested dicts aren't mutated by encryption;
        # otherwise saving the same object repeatedly would double-encrypt
        # values.
        import copy
        to_store = encrypt_settings(copy.deepcopy(settings))
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(to_store, f, indent=2)
        return True
    except Exception as e:
        # print(f'[Settings] Error saving to file: {e}')
        return False

class SSHClient:
    def __init__(self, host, username, password=None, key_file=None, port=22):
        self.host = host
        self.username = username
        self.password = password
        self.key_file = key_file
        self.port = port
        self.client = None
        self.connected = False
        
    def connect(self):
        try:
            # print(f'[SSHClient] Creating paramiko client')
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            if self.key_file:
                # print(f'[SSHClient] Connecting with key file: {self.key_file}')
                self.client.connect(self.host, port=self.port, username=self.username, 
                                   key_filename=self.key_file, timeout=10)
            else:
                # print(f'[SSHClient] Connecting with password')
                self.client.connect(self.host, port=self.port, username=self.username, 
                                   password=self.password, timeout=10)
            self.connected = True
            # print(f'[SSHClient] Connection successful')
            return True, "Connected successfully"
        except Exception as e:
            # print(f'[SSHClient] Connection error: {str(e)}')
            import traceback
            # print(f'[SSHClient] Traceback: {traceback.format_exc()}')
            return False, str(e)
    
    def execute_command(self, command):
        try:
            if not self.connected or not self.client:
                return False, "Not connected"
            
            stdin, stdout, stderr = self.client.exec_command(command)
            output = stdout.read().decode('utf-8')
            error = stderr.read().decode('utf-8')
            return True, output if output else error
        except Exception as e:
            return False, str(e)
    
    def disconnect(self):
        if self.client:
            self.client.close()
            self.connected = False

class OllamaClient:
    def __init__(self, host=OLLAMA_HOST, model=OLLAMA_MODEL):
        self.host = host
        self.model = model
    
    def generate(self, prompt, stream=False):
        try:
            url = f"{self.host}/api/generate"
            payload = {
                "model": self.model,
                "prompt": prompt,
                "stream": stream
            }
            
            response = requests.post(url, json=payload, timeout=300)
            response.raise_for_status()
            
            if stream:
                return True, response
            else:
                data = response.json()
                return True, data.get('response', '')
        except Exception as e:
            return False, str(e)
    
    def list_models(self):
        try:
            url = f"{self.host}/api/tags"
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()
            return True, data.get('models', [])
        except Exception as e:
            return False, str(e)
    
    def test_connection(self):
        try:
            url = f"{self.host}/api/tags"
            response = requests.get(url, timeout=5)
            response.raise_for_status()
            return True, "Connected"
        except Exception as e:
            return False, str(e)

# Routes
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/ollama/models')
def get_models():
    client = OllamaClient()
    success, data = client.list_models()
    if success:
        return jsonify({'success': True, 'models': [m['name'] for m in data]})
    return jsonify({'success': False, 'error': data}), 500

@app.route('/api/ollama/connect', methods=['POST'])
def connect_ollama():
    """Test connection to Ollama instance and get available models"""
    data = request.json
    ollama_url = data.get('url', OLLAMA_HOST).rstrip('/')
    
    if not ollama_url:
        return jsonify({'success': False, 'error': 'No URL provided'}), 400
    
    client = OllamaClient(host=ollama_url)
    success, message = client.test_connection()
    
    if not success:
        return jsonify({'success': False, 'error': f'Connection failed: {message}'}), 400
    
    # Get models
    success, models = client.list_models()
    if not success:
        return jsonify({'success': False, 'error': f'Failed to fetch models: {models}'}), 500
    
    model_names = [m['name'] for m in models] if models else []
    return jsonify({
        'success': True, 
        'message': f'Connected to Ollama at {ollama_url}',
        'models': model_names
    })

@app.route('/api/ollama/generate', methods=['POST'])
def generate_response():
    data = request.json
    prompt = data.get('prompt', '')
    
    if not prompt:
        return jsonify({'success': False, 'error': 'No prompt provided'}), 400
    
    client = OllamaClient()
    success, response = client.generate(prompt)
    
    if success:
        return jsonify({'success': True, 'response': response})
    return jsonify({'success': False, 'error': response}), 500

# SocketIO Events
@socketio.on('connect')
def handle_connect():
    # print(f'Client connected: {request.sid}')
    emit('connection_response', {'data': 'Connected to AI Terminal'})

@socketio.on('disconnect')
def handle_disconnect():
    # Clean up SSH connections
    if request.sid in ssh_connections:
        ssh_connections[request.sid].disconnect()
        del ssh_connections[request.sid]
    # Clean up both histories
    if request.sid in chat_histories:
        del chat_histories[request.sid]
    if request.sid in terminal_histories:
        del terminal_histories[request.sid]

@socketio.on('ai_execute_command')
def handle_ai_execute_command(data):
    """AI interprets user request and executes command"""
    try:
        request_text = data.get('request')
        url = data.get('url', OLLAMA_HOST)
        model = data.get('model', OLLAMA_MODEL)
        ai_name = data.get('aiName', 'Assistant')
        ai_role = data.get('aiRole', 'Linux Expert')
        history = data.get('history', [])
        
        if request.sid not in ssh_connections:
            emit('ai_command_result', {
                'success': False,
                'error': 'Not connected to SSH server. Please connect first.'
            })
            return
        
        # If terminal-side history is empty and client provided history, seed it
        if not terminal_histories.get(request.sid) and history:
            try:
                for msg in history[-50:]:
                    role = msg.get('role', 'user')
                    content = msg.get('content', '')
                    if content:
                        add_to_history(request.sid, role, content, chat=False)
            except Exception:
                pass

        # Build conversation context from terminal history (last 5 messages)
        context = format_history_for_prompt(request.sid, last_n=5, chat=False)

        # Create a prompt for the AI to interpret the command
        prompt = f"""You are {ai_name}, a {ai_role}. YOU HAVE FULL SSH ACCESS TO THE SERVER and can run any command.
{context}

A user has now requested: "{request_text}"

IMPORTANT INSTRUCTIONS:
- You MUST respond in EXACTLY this format, with each line starting with the exact keywords below.
- Do NOT use JSON, do NOT use code blocks, do NOT include any extra structured fields, and do NOT deviate from this format.
- Each response must have these 3 lines:

DECISION: [COMMAND if the user asks you to run something, or CONVERSATION if no command is needed]
COMMAND: [If DECISION is COMMAND, write the single shell command to run. If DECISION is CONVERSATION, write NONE]
RESPONSE: [Your human-readable analysis or conversational reply]

RESPONSE GUIDELINES (what to include in RESPONSE):
- Give a concise (1-3 sentence) explanation of why you chose the DECISION and what the COMMAND will do.
- If DECISION is COMMAND, briefly describe the *expected* output and how to interpret it (1-2 sentences).
- Important: After the command is executed by the system, you will be asked to comment on the *actual* command output. Prepare your RESPONSE so it can be extended later: summarize what to look for in the output and what would indicate success vs. failure.
- If the command could be destructive or risky (e.g., use of rm, dd, shutdown, usermod, etc.), include a one-line safety warning in the RESPONSE.
- If there is no expected output or the command typically produces no output, include a short one-line humorous remark you would add later (e.g., "No news is good news — looks like it succeeded quietly.").
- Keep the RESPONSE polite, concise, and useful. Use plain text only.

Examples:
User: "what is the hostname"
DECISION: COMMAND
COMMAND: hostname
RESPONSE: The hostname command retrieves the system's network identifier; it will print the hostname on one line.

User: "hello Terry"
DECISION: CONVERSATION
COMMAND: NONE
RESPONSE: Hi there! I'm ready to help you with any server tasks or questions you have."""
        
        # print(f'[AI] User request: {request_text}')
        # print(f'[AI] Conversation history messages: {len(history)}')
        # print(f'[AI] Using model: {model}')
        
        client = OllamaClient(host=url, model=model)
        success, response = client.generate(prompt)
        
        if not success:
            emit('ai_command_result', {
                'success': False,
                'error': f'AI processing failed: {response}'
            })
            return
        
        # print(f'[AI] Raw response:\n{response}')
        # Append AI response to **terminal** history for context
        try:
            add_to_history(request.sid, 'assistant', response, chat=False)
        except Exception:
            pass
        
        # Parse the AI response with robust parsing
        lines = response.strip().split('\n')
        response_type = 'CONVERSATION'  # default
        command = None
        ai_response = ""
        
        # Parse each line looking for keywords
        response_started = False
        for i, line in enumerate(lines):
            line_stripped = line.strip()
            
            if line_stripped.startswith('DECISION:'):
                response_type = line_stripped.replace('DECISION:', '').strip().upper()
                # print(f'[AI] Found DECISION: {response_type}')
            elif line_stripped.startswith('COMMAND:'):
                cmd_part = line_stripped.replace('COMMAND:', '').strip()
                if cmd_part.upper() != 'NONE':
                    command = cmd_part
                # print(f'[AI] Found COMMAND: {command}')
            elif line_stripped.startswith('RESPONSE:'):
                # Capture the rest of the response (everything after RESPONSE:)
                response_started = True
                ai_response = line_stripped.replace('RESPONSE:', '').strip()
                # Add all remaining lines to the response
                remaining_lines = [ai_response] if ai_response else []
                for j in range(i + 1, len(lines)):
                    remaining_lines.append(lines[j].rstrip())
                ai_response = '\n'.join(remaining_lines)
                # print(f'[AI] Found RESPONSE (multi-line): {ai_response[:100]}...')
                break  # Stop processing once we hit RESPONSE
        
        # print(f'[AI] Parsed - Type: {response_type}, Command: {command}, Response length: {len(ai_response)}')
        
        # If it's just conversation or no command needed
        if response_type == 'CONVERSATION' or command is None or command == 'NONE':
            # conversation replies go to terminal history but are not sent to the chat
            try:
                add_to_history(request.sid, 'assistant', ai_response if ai_response else response, chat=False)
            except Exception:
                pass
            emit('ai_command_result', {
                'success': True,
                'output': ai_response if ai_response else response,
                'type': 'info',
                # history for terminal context only
                'history': terminal_histories.get(request.sid, [])
            })
            return
        
        # Execute the command
        # print(f'[AI] Executing command: {command}')
        ssh_client = ssh_connections[request.sid]
        success, command_output = ssh_client.execute_command(command)
        
        # print(f'[AI] Command executed successfully: {success}')
        # print(f'[AI] Command output: {command_output}')
        
        # Ask the AI to comment on the actual output (summarize, highlight errors, or make a light joke if empty)
        try:
            post_prompt = f"""You are {ai_name}, a {ai_role}. The command below was executed:
{command}

The output produced was:
{command_output}

In a concise (1-4 sentence) plain-text comment, do the following:
- Summarize the most important information in the output.
- If the output is empty or only whitespace, reply with a short light-hearted one-line joke and a confirmation that the command likely succeeded (or suggest a verification step).
- If the output contains errors, point out the principal error lines and suggest a safe next step.
- Do NOT include additional shell commands or structured data. Keep it helpful and to the point.
"""
            post_success, post_response = client.generate(post_prompt)
            if post_success:
                analysis = post_response.strip()
            else:
                analysis = ai_response if ai_response else f"No analysis available: {post_response}"
        except Exception as e:
            analysis = ai_response if ai_response else f"No analysis available: {e}"
        
        # Format the result: command + output + analysis
        result_parts = [
            f"Command: {command}",
            f"Result: {command_output}",
            f"Analysis: {analysis}"
        ]
        result_text = "\n\n".join(result_parts)
        
        emit('ai_command_result', {
            'success': success,
            'output': result_text,
            'type': 'success' if success else 'error'
        })
        
    except Exception as e:
        import traceback
        print(f'[AI] Exception: {str(e)}')
        print(f'[AI] Traceback: {traceback.format_exc()}')
        emit('ai_command_result', {
            'success': False,
            'error': str(e)
        })

@socketio.on('ssh_connect')
def handle_ssh_connect(data):
    try:
        host = data.get('host', '').strip()
        username = data.get('username', '').strip()
        password = data.get('password', '')
        key_file = data.get('key_file', '')
        port = int(data.get('port', 22))
        
        print(f'[SSH] Raw data received: {data}')
        print(f'[SSH] Parsed - host: "{host}", username: "{username}", port: {port}, key_file: "{key_file}"')
        
        # Validate inputs
        if not host:
            print('[SSH] Validation error: host is empty')
            emit('ssh_status', {'connected': False, 'message': 'Host is required'})
            return
        
        if not username:
            print('[SSH] Validation error: username is empty')
            emit('ssh_status', {'connected': False, 'message': 'Username is required'})
            return
        
        print(f'[SSH] Attempting connection to {username}@{host}:{port}')
        print(f'[SSH] Auth method: {"key file" if key_file else "password"}')
        
        ssh_client = SSHClient(host, username, password if not key_file else None, key_file, port)
        success, message = ssh_client.connect()
        
        if success:
            ssh_connections[request.sid] = ssh_client
            print(f'[SSH] Successfully connected to {host}')
            print(f'[SSH] Connection stored with SID: {request.sid}')
            emit('ssh_status', {'connected': True, 'message': 'Connected successfully'})
        else:
            print(f'[SSH] Connection failed to {host}: {message}')
            emit('ssh_status', {'connected': False, 'message': f'Connection failed: {message}'})
    except Exception as e:
        import traceback
        print(f'[SSH] Exception during connection: {str(e)}')
        print(f'[SSH] Traceback: {traceback.format_exc()}')
        emit('ssh_status', {'connected': False, 'message': f'Error: {str(e)}'})

@socketio.on('ssh_command')
def handle_ssh_command(data):
    try:
        command = data.get('command')
        
        if request.sid not in ssh_connections:
            emit('command_output', {'success': False, 'output': 'Not connected to SSH server'})
            return
        
        ssh_client = ssh_connections[request.sid]
        
        # Get current directory for this session
        current_dir = current_directories.get(request.sid, None)
        print(f'[DEBUG] Before command: {command!r} | Tracked dir: {current_dir!r}')

        import shlex
        # Always run the full command as typed, but update the tracked directory if any cd is present
        base_dir = current_dir
        run_cmd = command
        # We'll split on ; and && to find cd commands
        def split_commands(cmd):
            import re
            # Split on ; or &&, but keep the delimiters
            parts = re.split(r'(;|&&)', cmd)
            result = []
            buf = ''
            for part in parts:
                if part in (';', '&&'):
                    if buf.strip():
                        result.append(buf.strip())
                    result.append(part)
                    buf = ''
                else:
                    buf += part
            if buf.strip():
                result.append(buf.strip())
            return result

        if base_dir:
            cmds = split_commands(command)
            last_dir = base_dir
            i = 0
            only_cd = True
            cd_failed = False
            for part in cmds:
                if part in (';', '&&'):
                    continue
                if part.startswith('cd '):
                    try:
                        cd_parts = shlex.split(part)
                        if len(cd_parts) >= 2:
                            cd_target = cd_parts[1]
                            print(f'[DEBUG] Attempting cd to: {cd_target!r} from {last_dir!r}')
                            exec_cmd = f'cd "{last_dir}" && cd {shlex.quote(cd_target)} && pwd'
                            success, output = ssh_client.execute_command(exec_cmd)
                            print(f'[DEBUG] cd result: success={success}, output={output!r}')
                            if success and output.strip():
                                last_dir = output.strip().splitlines()[-1]
                                print(f'[DEBUG] Updated tracked dir: {last_dir!r}')
                            else:
                                cd_failed = True
                                cd_error = output
                                break
                    except Exception as e:
                        cd_failed = True
                        cd_error = str(e)
                        break
                else:
                    only_cd = False
            if cd_failed:
                emit('command_output', {'success': False, 'output': cd_error})
                return
            # Update tracked directory only if all cd's succeeded
            current_directories[request.sid] = last_dir
            # If the command is only a single cd, don't run anything else, just return the new dir
            if only_cd and len(cmds) == 1 and cmds[0].startswith('cd '):
                emit('command_output', {'success': True, 'output': last_dir})
                return
            # Otherwise, run the command in the latest directory
            print(f'[DEBUG] Running command in dir: {last_dir!r} | Command: {command!r}')
            exec_cmd = f'cd "{last_dir}" && {command}'
            success, output = ssh_client.execute_command(exec_cmd)
        else:
            # No current directory tracked yet, just execute
            success, output = ssh_client.execute_command(command)
            # If this was the first command, get and store the directory
            if success and request.sid not in current_directories:
                pwd_success, pwd_output = ssh_client.execute_command('pwd')
                if pwd_success:
                    current_directories[request.sid] = pwd_output.strip()
        emit('command_output', {'success': success, 'output': output})
    except Exception as e:
        emit('command_output', {'success': False, 'output': str(e)})

@socketio.on('ollama_prompt')
def handle_ollama_prompt(data):
    """Handle a simple AI chat message and maintain conversation history."""
    try:
        prompt = data.get('prompt') or data.get('message')
        url = data.get('url', OLLAMA_HOST)
        model = data.get('model', OLLAMA_MODEL)
        if not prompt:
            emit('ai_response', {'success': False, 'error': 'No prompt provided'})
            return

        # Prepare context from server-side history
        context = format_history_for_prompt(request.sid)
        full_prompt = f"{context}\nUser: {prompt}\nAssistant:" if context else f"User: {prompt}\nAssistant:"

        client = OllamaClient(host=url, model=model)
        success, response = client.generate(full_prompt)

        if success:
            # Append messages to chat history only
            add_to_history(request.sid, 'user', prompt, chat=True)
            add_to_history(request.sid, 'assistant', response, chat=True)
            emit('ai_response', {
                'success': True,
                'response': response,
                'history': chat_histories.get(request.sid, [])
            })
        else:
            emit('ai_response', {'success': False, 'error': response})
    except Exception as e:
        emit('ai_response', {'success': False, 'error': str(e)})

@socketio.on('ollama_command_generation')
def handle_command_generation(data):
    """Generate a command using AI based on natural language"""
    try:
        description = data.get('description')
        context = data.get('context', 'Generate a shell command')
        url = data.get('url', OLLAMA_HOST)
        model = data.get('model', OLLAMA_MODEL)
        auto_run = data.get('auto_run', False)
        
        prompt = f"{context}: {description}"
        
        client = OllamaClient(host=url, model=model)
        success, response = client.generate(prompt)
        
        if success:
            command = response.strip()
            emit('generated_command', {
                'success': True, 
                'command': command,
                'auto_run': auto_run
            })
        else:
            emit('generated_command', {'success': False, 'error': response})
    except Exception as e:
        emit('generated_command', {'success': False, 'error': str(e)})

@socketio.on('get_history')
def handle_get_history(_data=None):
    """Return only the _chat_ history for this socket session."""
    try:
        emit('history', {'success': True, 'history': chat_histories.get(request.sid, [])})
    except Exception as e:
        emit('history', {'success': False, 'error': str(e)})

@socketio.on('clear_history')
def handle_clear_history(_data=None):
    try:
        if request.sid in chat_histories:
            del chat_histories[request.sid]
        if request.sid in terminal_histories:
            del terminal_histories[request.sid]
        emit('history_cleared', {'success': True})
    except Exception as e:
        emit('history_cleared', {'success': False, 'error': str(e)})

@app.route('/api/settings', methods=['GET'])
def get_settings():
    """Get user settings from file

    Returned settings are decrypted so the front end can populate forms.  No
    changes are made on disk by this endpoint.
    """
    try:
        settings = load_settings_from_file()
        return jsonify({'success': True, 'settings': settings})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/hosts', methods=['GET'])
def get_hosts():
    """Get saved SSH hosts"""
    try:
        settings = load_settings_from_file()
        hosts = settings.get('hosts', [])
        # hosts are already decrypted by load_settings_from_file
        return jsonify({'success': True, 'hosts': hosts})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/hosts', methods=['POST'])
def save_host():
    """Save a new SSH host"""
    try:
        host_data = request.json
        settings = load_settings_from_file()
        
        if 'hosts' not in settings:
            settings['hosts'] = []
        
        # Check if host already exists (by name)
        host_name = host_data.get('name')
        existing_hosts = [h for h in settings['hosts'] if h.get('name') != host_name]
        existing_hosts.append(host_data)
        settings['hosts'] = existing_hosts
        
        save_settings_to_file(settings)
        return jsonify({'success': True, 'message': 'Host saved'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/hosts/<host_name>', methods=['DELETE'])
def delete_host(host_name):
    """Delete a saved SSH host"""
    try:
        settings = load_settings_from_file()
        if 'hosts' in settings:
            settings['hosts'] = [h for h in settings['hosts'] if h.get('name') != host_name]
            save_settings_to_file(settings)
        return jsonify({'success': True, 'message': 'Host deleted'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/settings', methods=['POST'])
def save_settings():
    """Save user settings to file"""
    try:
        new_settings = request.json
        # Load existing settings to preserve hosts and other data
        existing_settings = load_settings_from_file()
        # Merge new settings with existing ones
        existing_settings.update(new_settings)
        success = save_settings_to_file(existing_settings)
        if success:
            return jsonify({'success': True, 'message': 'Settings saved'})
        else:
            return jsonify({'success': False, 'error': 'Failed to save settings'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})
        return jsonify({'success': False, 'error': str(e)})

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=1010)
