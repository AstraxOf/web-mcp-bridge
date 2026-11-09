#!/usr/bin/env python3
"""github_push.py - Empuja un archivo ya concatenado a GitHub via Contents API."""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"


def _req(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub {e.code}: {detail[:300]}") from None


def push(path: str, text: str, owner: str, repo: str, branch: str, message: str, sha: str | None = None) -> dict:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("Falta GITHUB_TOKEN en el entorno del servidor staging")
    body = {
        "message": message,
        "branch": branch,
        "content": base64.b64encode(text.encode("utf-8")).decode("ascii"),
    }
    if sha:
        body["sha"] = sha
    url = f"{API}/repos/{owner}/{repo}/contents/{urllib.parse.quote(path)}"
    out = _req("PUT", url, token, body)
    commit = out.get("commit", {})
    return {
        "ok": True,
        "path": path,
        "sha": out.get("content", {}).get("sha"),
        "commit_sha": commit.get("sha"),
        "html_url": commit.get("html_url"),
        "bytes": len(text.encode("utf-8")),
    }
