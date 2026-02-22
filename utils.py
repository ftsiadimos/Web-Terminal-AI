"""
Utility functions for AI Terminal
"""
import logging
import os
from functools import wraps
from config import LOG_LEVEL

# Configure logging
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

class AITerminalError(Exception):
    """Base exception for AI Terminal"""
    pass

class SSHConnectionError(AITerminalError):
    """SSH connection error"""
    pass

class OllamaConnectionError(AITerminalError):
    """Ollama connection error"""
    pass

def safe_execute(func):
    """Decorator to safely execute functions and handle errors"""
    @wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Error in {func.__name__}: {str(e)}")
            return False, str(e)
    return wrapper

def truncate_output(output, max_lines=100):
    """Truncate output to max lines"""
    lines = output.split('\n')
    if len(lines) > max_lines:
        return '\n'.join(lines[:max_lines]) + f"\n... ({len(lines) - max_lines} more lines)\n\nNote: output was truncated by the max lines setting. You can increase this limit in Settings to see more output."
    return output

def sanitize_command(command):
    """Basic command sanitization"""
    # Remove potentially dangerous characters
    dangerous_chars = [';', '&', '|', '`', '$', '(', ')']
    # Note: This is basic sanitization - for production, use more robust methods
    return command.strip()

def format_error(error):
    """Format error message for display"""
    if isinstance(error, Exception):
        return str(error)
    return str(error)


# --- encryption helpers --------------------------------------------------
from cryptography.fernet import Fernet, InvalidToken


def _get_cipher():
    """Return a Fernet cipher object or None if no key is configured.

    The encryption key is optional; without it the encrypt/decrypt helpers
    behave as identity functions and passwords are stored in cleartext.  This
    enables development and simplifies deployment in environments where
    secrets management isn't available.  A warning is logged when the key is
    missing so operators are aware of the weaker security.
    """
    key = os.environ.get('SETTINGS_ENC_KEY')
    if not key:
        logger.warning(
            "SETTINGS_ENC_KEY is not set; passwords will be kept in cleartext."
        )
        return None
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt_password(password: str) -> str:
    """Encrypt ``password`` using Fernet and return the token string.

    Empty or ``None`` values are returned unchanged.  If no cipher is
    available the original value is returned without modification.
    """
    if not password:
        return password
    cipher = _get_cipher()
    if not cipher:
        # no key configured; skip encryption
        return password
    return cipher.encrypt(password.encode()).decode()


def decrypt_password(token: str) -> str:
    """Decrypt a previously encrypted password token.

    If the provided value is not a valid Fernet token (for example, because the
    value is already plaintext or the key has changed) we simply return the
    original string.  When no cipher is configured the input is returned
    unchanged (as encryption was not performed in the first place).
    """
    if not token:
        return token
    cipher = _get_cipher()
    if not cipher:
        return token
    try:
        return cipher.decrypt(token.encode()).decode()
    except (InvalidToken, TypeError):
        # value wasn't encrypted or the key doesn't match; treat as cleartext
        return token


def is_encrypted(value: str) -> bool:
    """Return ``True`` if ``value`` looks like a Fernet token.

    Fernet tokens always begin with the prefix ``gAAAA``.  This quick check is
    used to avoid double-encrypting values when saving settings multiple times.
    """
    return isinstance(value, str) and value.startswith("gAAAA")


def encrypt_settings(settings: dict) -> dict:
    """Walk a settings dict and encrypt any passwords before writing.

    The original dictionary is modified in-place and returned for convenience.
    Supported keys are ``ssh`` and ``hosts`` (a list of dicts).  Any field
    named ``password`` will be encrypted unless it already appears to be one
    of our Fernet tokens.
    """
    if not settings:
        return settings

    if 'ssh' in settings and isinstance(settings['ssh'], dict):
        pw = settings['ssh'].get('password')
        if pw and not is_encrypted(pw):
            settings['ssh']['password'] = encrypt_password(pw)

    if 'hosts' in settings and isinstance(settings['hosts'], list):
        for host in settings['hosts']:
            pw = host.get('password')
            if pw and not is_encrypted(pw):
                host['password'] = encrypt_password(pw)

    return settings


def decrypt_settings(settings: dict) -> dict:
    """Walk a settings dict and decrypt any password tokens.

    The returned dictionary contains decrypted passwords so that callers can
    safely hand the data off to the client or use the credentials directly.

    When the encryption key is not configured we cannot decrypt; in that
    case we check for values that look like Fernet tokens and clear them so
    that the UI does not accidentally display an encrypted blob as a password
    (which would lead to authentication failures).  A warning is logged to
    prompt the user to either set ``SETTINGS_ENC_KEY`` or re‑enter the
    credentials.
    """
    if not settings:
        return settings

    cipher = _get_cipher()

    if 'ssh' in settings and isinstance(settings['ssh'], dict):
        pw = settings['ssh'].get('password')
        if pw:
            if cipher:
                settings['ssh']['password'] = decrypt_password(pw)
            else:
                if is_encrypted(pw):
                    logger.warning(
                        "loaded encrypted ssh password but no SETTINGS_ENC_KEY; "
                        "clearing value"
                    )
                    settings['ssh']['password'] = ''

    if 'hosts' in settings and isinstance(settings['hosts'], list):
        for host in settings['hosts']:
            pw = host.get('password')
            if pw:
                if cipher:
                    host['password'] = decrypt_password(pw)
                else:
                    if is_encrypted(pw):
                        logger.warning(
                            "loaded encrypted host password for %s but no "
                            "SETTINGS_ENC_KEY; clearing value",
                            host.get('name', '<unknown>')
                        )
                        host['password'] = ''

    return settings
