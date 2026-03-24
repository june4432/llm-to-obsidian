#!/usr/bin/python3
"""
Native Messaging Host for LLM-to-Obsidian Chrome Extension.
Launched via the compiled native_host binary (macOS blocks script execution from Chrome).
"""

import json
import os
import struct
import subprocess
import sys
import traceback
import warnings
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Suppress Python warnings (stderr is already redirected by the C wrapper)
warnings.filterwarnings("ignore")

# ── Paths ──
HOST_DIR = Path(__file__).parent.resolve()
PROMPT_PATH = HOST_DIR / "prompts" / "conversation-to-note.md"
ENV_PATH = HOST_DIR / ".env"
LOG_PATH = HOST_DIR / "debug.log"


# ── File Logging ──
def flog(msg):
    """Append a line to debug.log for troubleshooting."""
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            ts = datetime.now().strftime("%H:%M:%S")
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def load_env():
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())


def get_api_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key

    claude_dir = Path.home() / ".claude"
    for fname in ["credentials.json", "config.json"]:
        fp = claude_dir / fname
        if fp.exists():
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                for field in ["apiKey", "api_key", "key", "token"]:
                    if field in data:
                        return data[field]
            except (json.JSONDecodeError, KeyError):
                continue
    return None


def get_kst_now():
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst).strftime("%Y-%m-%d %H:%M")


def load_system_prompt():
    if not PROMPT_PATH.exists():
        return "Convert the given markdown content into a structured note."
    return PROMPT_PATH.read_text(encoding="utf-8")


def call_claude_api(api_key, markdown_content):
    import anthropic

    flog(f"API call start, content length: {len(markdown_content)}")

    client = anthropic.Anthropic(api_key=api_key)
    system_prompt = load_system_prompt()
    current_time = get_kst_now()

    user_message = (
        f"현재 시간(KST): {current_time}\n\n"
        f"아래 원본 내용을 conversation-to-note 포맷의 Obsidian 노트로 변환해줘.\n\n"
        f"중요한 규칙:\n"
        f"- 출력은 순수 마크다운 텍스트만 반환할 것. ```markdown```, ```yaml``` 등 코드 펜스로 감싸지 말 것.\n"
        f"- YAML 프론트매터(---)로 시작하고, 바로 본문이 이어져야 함.\n"
        f"- 프론트매터의 created 필드에 위 현재 시간을 사용할 것.\n"
        f"- 출력 예시:\n"
        f"---\n"
        f"created: {current_time}\n"
        f"title: \"제목\"\n"
        f"tags:\n"
        f"  - type/insight\n"
        f"  - topic/ai\n"
        f"source: \"\"\n"
        f"---\n"
        f"\n"
        f"# 제목\n"
        f"\n"
        f"> 한 줄 요약\n"
        f"\n"
        f"(이하 본문)\n\n"
        f"--- 원본 내용 ---\n\n"
        f"{markdown_content}"
    )

    flog("Calling Claude API (haiku)...")
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4096,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )

    result = message.content[0].text
    result = strip_code_fences(result)
    flog(f"API call done, response length: {len(result)}")
    return result


def strip_code_fences(text):
    """Remove wrapping code fences if the entire response is wrapped."""
    import re
    stripped = text.strip()
    # Remove ```markdown ... ``` or ```yaml ... ``` wrapping
    m = re.match(r'^```(?:markdown|yaml|md)?\s*\n([\s\S]*?)\n```\s*$', stripped)
    if m:
        return m.group(1).strip()
    # Remove leading ```markdown and trailing ``` even if not perfectly matched
    if stripped.startswith('```'):
        lines = stripped.split('\n')
        # Remove first line (```markdown)
        lines = lines[1:]
        # Remove last line if it's just ```)
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        return '\n'.join(lines).strip()
    return text


def extract_title(note_content):
    for line in note_content.splitlines():
        line = line.strip()
        if line.startswith("title:"):
            title = line[6:].strip().strip('"').strip("'")
            if title:
                return title
        if line.startswith("# ") and not line.startswith("# {"):
            return line[2:].strip()
    return f"note-{get_kst_now().replace(':', '-').replace(' ', '_')}"


def save_to_vault(vault_path, note_content, title):
    inbox = Path(vault_path) / "1-inbox"
    inbox.mkdir(parents=True, exist_ok=True)

    safe_title = "".join(c if c not in r'\/:*?"<>|' else "_" for c in title)
    file_path = inbox / f"{safe_title}.md"

    counter = 1
    while file_path.exists():
        file_path = inbox / f"{safe_title}_{counter}.md"
        counter += 1

    file_path.write_text(note_content, encoding="utf-8")
    flog(f"Saved to: {file_path}")
    return file_path


def git_sync(vault_path, file_path, title):
    result = {"git_success": False, "git_message": ""}
    flog("Git sync start")

    try:
        check = subprocess.run(
            ["git", "status"], cwd=vault_path,
            capture_output=True, text=True, timeout=10,
        )
        if check.returncode != 0:
            result["git_message"] = "Not a git repository"
            return result

        # git pull
        pull = subprocess.run(
            ["git", "pull", "origin", "main"], cwd=vault_path,
            capture_output=True, text=True, timeout=30,
        )
        if pull.returncode != 0:
            subprocess.run(
                ["git", "pull", "origin", "master"], cwd=vault_path,
                capture_output=True, text=True, timeout=30,
            )

        # git add
        rel_path = os.path.relpath(file_path, vault_path)
        subprocess.run(
            ["git", "add", rel_path], cwd=vault_path,
            capture_output=True, text=True, timeout=10,
        )

        # git commit
        commit_msg = f"note: {title} (via llm-to-obsidian)"
        commit = subprocess.run(
            ["git", "commit", "-m", commit_msg], cwd=vault_path,
            capture_output=True, text=True, timeout=10,
        )
        if commit.returncode != 0 and "nothing to commit" in commit.stdout:
            result["git_message"] = "Nothing to commit"
            result["git_success"] = True
            flog("Git: nothing to commit")
            return result

        # git push
        push = subprocess.run(
            ["git", "push"], cwd=vault_path,
            capture_output=True, text=True, timeout=30,
        )
        if push.returncode == 0:
            result["git_success"] = True
            result["git_message"] = "Pushed successfully"
            flog("Git: pushed")
        else:
            result["git_message"] = f"Push failed: {push.stderr[:200]}"
            flog(f"Git push failed: {push.stderr[:200]}")

    except subprocess.TimeoutExpired:
        result["git_message"] = "Git operation timed out"
        flog("Git: timeout")
    except FileNotFoundError:
        result["git_message"] = "git command not found"
        flog("Git: not found")
    except Exception as e:
        result["git_message"] = str(e)
        flog(f"Git error: {e}")

    return result


# ── Native Messaging Protocol ──

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("=I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(message):
    encoded = json.dumps(message, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main():
    flog("=== Host started ===")

    try:
        load_env()
        flog("Env loaded")

        message = read_message()
        if not message:
            flog("No input received")
            send_message({"success": False, "error": "No input received"})
            return

        action = message.get("action")
        vault_path = message.get("vault_path", "")
        flog(f"Action: {action}, vault: {vault_path}")

        # ── Test ──
        if action == "test":
            checks = {
                "python": sys.version,
                "vault_path": vault_path,
                "vault_exists": os.path.isdir(vault_path) if vault_path else False,
                "inbox_exists": os.path.isdir(os.path.join(vault_path, "1-inbox")) if vault_path else False,
                "api_key_found": get_api_key() is not None,
                "prompt_exists": PROMPT_PATH.exists(),
            }
            try:
                import anthropic
                checks["anthropic_sdk"] = anthropic.__version__
            except ImportError:
                checks["anthropic_sdk"] = "NOT INSTALLED"
            try:
                git_check = subprocess.run(
                    ["git", "--version"],
                    capture_output=True, text=True, timeout=5,
                )
                checks["git"] = git_check.stdout.strip()
            except Exception:
                checks["git"] = "NOT FOUND"

            send_message({"success": True, "checks": checks})
            flog(f"Test done: {checks}")
            return

        # ── Convert and save ──
        if action != "convert_and_save":
            send_message({"success": False, "error": f"Unknown action: {action}"})
            return

        content = message.get("content")
        if not content:
            flog("No content")
            send_message({"success": False, "error": "No markdown content provided"})
            return
        if not vault_path:
            flog("No vault path")
            send_message({"success": False, "error": "No vault path configured"})
            return

        api_key = get_api_key()
        if not api_key:
            flog("No API key")
            send_message({"success": False, "error": "No API key found."})
            return

        flog(f"Content length: {len(content)}")

        # Convert
        note_content = call_claude_api(api_key, content)
        flog(f"Converted, length: {len(note_content)}")

        # Title
        title = extract_title(note_content)
        flog(f"Title: {title}")

        # Save
        file_path = save_to_vault(vault_path, note_content, title)
        flog(f"File saved: {file_path}")

        # Git
        git_result = git_sync(vault_path, file_path, title)
        flog(f"Git result: {git_result}")

        send_message({
            "success": True,
            "title": title,
            "file_name": file_path.name,
            "file_path": str(file_path),
            "git": git_result,
        })
        flog("=== Done ===")

    except Exception as e:
        flog(f"FATAL ERROR: {traceback.format_exc()}")
        try:
            send_message({"success": False, "error": str(e)})
        except Exception:
            flog(f"Failed to send error response: {traceback.format_exc()}")


if __name__ == "__main__":
    main()
