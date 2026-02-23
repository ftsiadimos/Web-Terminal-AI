# 🤖 AI Terminal — Web UI for SSH + Ollama

A lightweight Flask app that provides a web-based terminal (SSH only) alongside a separate AI chat pane, with optional Ollama-powered command assistance.

## Why this repo
- Quickly prototype running AI-generated shell commands against remote hosts via SSH.
- Useful for experimentation with Ollama models and interactive command workflows.

---

## Key features
- Web terminal UI + multi-tab chat (terminal pane is SSH-only; AI chat is separate)
- Ollama integration for command generation and analysis (via AI tab using `?` or `/ai` prefixes or automatic forwarding on errors)
- SSH execution (Paramiko)
- Real-time updates via Socket.IO

---

## Local development (recommended) 🚀
Follow these steps to get the project running locally.

### Prerequisites
- Python 3.7+
- (Optional) Ollama running locally if you want AI features: `ollama serve` (default: `http://localhost:11434`)

### Quick start
1. Clone the repo and run the Docker container (fastest way to try it):

   ```bash
   docker run -d --restart unless-stopped -p 1010:1010 --name=webaiterminal ftsiadimos/webaiterminal:latest

   ```

2. Alternatively, start with Docker Compose using the example file:

   ```bash
   git clone https://github.com/ftsiadimos/Web-Terminal-AI && cd Web-AI-Terminal 
   cp docker-compose.example.yml docker-compose.yml
   docker compose pull
   docker compose up -d
   ```

3. For local development without containers, use the manual installation:

   git clone <repo-url> && cd Web-AI-Terminal
   ./start.sh

   - The script will create/activate a virtualenv, install `requirements.txt`, copy `.env.example` → `.env` (if needed), and run the server.

4. Open the UI in your browser:

   http://localhost:1010

   (Note: the Flask/SocketIO server listens on port `1010` by default.)

### Manual setup (if you prefer)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # edit values if needed (OLLAMA_HOST, OLLAMA_MODEL)
python app.py
```

### Environment variables
Set or edit `.env` (see `.env.example`) for:
- `OLLAMA_HOST` (default: `http://localhost:11434`)
- `OLLAMA_MODEL` (default: `llama2`)
- `SECRET_KEY`, `FLASK_ENV`, `FLASK_DEBUG`
- **`SETTINGS_ENC_KEY`** – a Fernet key used to encrypt SSH passwords stored in
  `user_settings.json`.  You can generate one with:
  ```bash
  python - <<'PYTHON'
  from cryptography.fernet import Fernet
  print(Fernet.generate_key().decode())
  PYTHON
  ```
  Without this key the application will still run, but passwords will be saved
  in cleartext.  **If a settings file already contains encrypted values and the
  key is missing, those fields will be cleared when the server starts**.  You
  must either supply the same key used originally or re‑enter the password in
  the UI before attempting SSH connections.


If you are running via Docker the same variables can be provided in the image or in
`docker-compose.example.yml` (copy it to `docker-compose.yml` and adjust as needed).

### Run tests
- Install test runner (if not installed): `pip install pytest`
- Run tests: `pytest -q`

---

## Useful commands
- ./start.sh — full local dev startup (recommended)
- python app.py — run server manually
- pytest -q — run unit tests

---

## Troubleshooting
- If the UI shows AI errors, ensure Ollama is running: `ollama serve` and `curl http://localhost:11434/api/tags`
- If SSH fails, verify credentials and key permissions (`chmod 600 ~/.ssh/id_rsa`)
- Server logs appear in the terminal where `python app.py` or `./start.sh` runs

---

## Contributing & License
- Contributions welcome — please open PRs.
- License: MIT

---
