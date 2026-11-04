"""Serve an explicitly selected directory for local media development."""
import os
from pathlib import Path
from flask import Flask, send_from_directory
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
MEDIA_ROOT = Path(os.environ.get("FREE2Z_TEST_MEDIA_ROOT", "./media")).resolve()

@app.route("/<path:filename>")
def media_file(filename):
    return send_from_directory(MEDIA_ROOT, filename)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8001)
