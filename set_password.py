"""Run this to set or change the password:  python set_password.py
Only a scrypt hash is written to data/password.hash. Changing it logs out every existing session."""
import getpass
import os
import sys

from werkzeug.security import generate_password_hash

from auth import DATA, HASH_FILE

DATA.mkdir(exist_ok=True)
pw = getpass.getpass("New password: ")
if len(pw) < 4:
    sys.exit("Use at least 8 characters.")
if pw != getpass.getpass("Repeat it: "):
    sys.exit("Those did not match.")

tmp = HASH_FILE.with_suffix(".tmp")
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write(generate_password_hash(pw, method="scrypt"))
os.replace(tmp, HASH_FILE)
print("Password saved.")
