#!/usr/bin/env python3
"""
Simple script to verify the password encryption helpers and settings handling.
This mirrors the lightweight test style used by the other modules in the repo.
"""

import os
from cryptography.fernet import Fernet
from utils import (
    encrypt_password,
    decrypt_password,
    is_encrypted,
    encrypt_settings,
    decrypt_settings,
)

# ensure we have a deterministic key for testing
os.environ['SETTINGS_ENC_KEY'] = Fernet.generate_key().decode()

print("\n--- testing basic password encryption ---")
plain = "mypassword"
encrypted = encrypt_password(plain)
print(f"plain: {plain}")
print(f"encrypted: {encrypted}")

assert encrypted != plain, "encryption should change the value"
print("✓ encryption produced a different token")

assert is_encrypted(encrypted), "is_encrypted should recognize the token"
print("✓ is_encrypted recognizes token")

decoded = decrypt_password(encrypted)
assert decoded == plain, f"decrypt_password should return original, got {decoded!r}"
print("✓ decrypt_password round‑tripped successfully")

# verify non‑tokens are returned unchanged
print("\n--- verifying non‑encrypted input is unaffected ---")
unchanged = decrypt_password(plain)
assert unchanged == plain, "decrypt_password should leave cleartext unchanged"
print("✓ decrypt_password leaves cleartext alone")

# now test the settings helpers
print("\n--- testing settings encryption helpers ---")
settings = {
    'ssh': {'host': 'localhost', 'password': 'sshpass'},
    'hosts': [
        {'name': 'server1', 'username': 'user1', 'password': 'hostpass'}
    ]
}
enc_settings = encrypt_settings(settings.copy())
print(f"encrypted settings: {enc_settings}")
assert is_encrypted(enc_settings['ssh']['password']) and \
       is_encrypted(enc_settings['hosts'][0]['password']), \
       "encrypt_settings should encrypt both passwords"
print("✓ encrypt_settings processed both passwords")

dec_settings = decrypt_settings(enc_settings.copy())
assert dec_settings['ssh']['password'] == 'sshpass', "ssh password should be decrypted"
assert dec_settings['hosts'][0]['password'] == 'hostpass', "host password should be decrypted"
print("✓ decrypt_settings restored original passwords")

# perform a quick integration cycle using the actual app helpers and a temp file
print("\n--- integration test with app.load/save ---")
import tempfile, json
import app

with tempfile.NamedTemporaryFile('w+', delete=False) as tf:
    app.SETTINGS_FILE = tf.name
    sample = {'ssh': {'host': 'foo', 'password': 'bar'}}
    # ensure key is present
    import os
    from cryptography.fernet import Fernet
    os.environ['SETTINGS_ENC_KEY'] = Fernet.generate_key().decode()

    app.save_settings_to_file(sample)
    # file on disk should contain encrypted password
    tf.seek(0)
    stored = json.load(tf)
    assert stored['ssh']['password'] != 'bar', "password should be encrypted on disk"
    # loading through helper should decrypt
    loaded = app.load_settings_from_file()
    assert loaded['ssh']['password'] == 'bar', "load_settings_from_file should return decrypted value"

    # now simulate missing key: remove from env and reload
    os.environ.pop('SETTINGS_ENC_KEY', None)
    loaded2 = app.load_settings_from_file()
    assert loaded2['ssh']['password'] == '', "password should be cleared when key is missing"

print("✓ integration save/load cycle succeeded (including key-absent case)")

print("\nAll encryption tests completed.\n")
