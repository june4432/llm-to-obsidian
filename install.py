#!/usr/bin/env python3
"""
Install script for LLM-to-Obsidian Native Messaging Host.

Registers the Native Messaging Host manifest so Chrome can find and
launch the host process.

Usage:
    python install.py [--uninstall] [--extension-id EXTENSION_ID]
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

HOST_NAME = "com.llm_to_obsidian.host"
HOST_SCRIPT = "convert_and_save.py"


def get_python_path():
    """Get the absolute path to the current Python interpreter."""
    return shutil.which("python3") or shutil.which("python") or sys.executable


def get_host_dir():
    """Get absolute path to the host directory."""
    return (Path(__file__).parent / "host").resolve()


def get_host_script_path():
    """Get absolute path to the host script."""
    return str(get_host_dir() / HOST_SCRIPT)


def build_native_binary(host_dir):
    """Compile the C wrapper binary for macOS.

    macOS blocks Chrome from directly executing script files (.sh, .py).
    A compiled Mach-O binary is required as the native messaging entry point.
    """
    source = host_dir / "native_host.c"
    binary = host_dir / "native_host"

    if not source.exists():
        print(f"  ERROR: {source} not found")
        return None

    print("  Compiling native_host binary...")
    result = subprocess.run(
        ["cc", "-o", str(binary), str(source)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  ERROR: Compilation failed: {result.stderr}")
        return None

    binary.chmod(0o755)

    # Ad-hoc codesign
    subprocess.run(
        ["codesign", "-s", "-", str(binary)],
        capture_output=True, text=True,
    )

    print(f"  Built: {binary}")
    return str(binary)


def create_manifest(extension_id):
    """Create the Native Messaging Host manifest JSON."""
    system = platform.system()
    host_dir = get_host_dir()

    if system == "Windows":
        # On Windows, use a batch wrapper (can't use shebang)
        batch_path = str(host_dir / "run_host.bat")
        create_windows_batch(batch_path, get_host_script_path())
        entry_point = batch_path
    elif system == "Darwin":
        # macOS — must use a compiled binary (Gatekeeper blocks scripts)
        entry_point = build_native_binary(host_dir)
        if not entry_point:
            print("  Falling back to Python script (may not work on macOS)")
            entry_point = get_host_script_path()
    else:
        # Linux — shell wrapper works fine
        shell_path = str(host_dir / "run_host.sh")
        create_linux_shell(shell_path, get_host_script_path())
        entry_point = shell_path

    manifest = {
        "name": HOST_NAME,
        "description": "LLM-to-Obsidian: Convert and save LLM conversations to Obsidian",
        "path": entry_point,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    }

    return manifest


def create_linux_shell(shell_path, host_script):
    """Create a shell wrapper for Linux."""
    python_path = get_python_path()
    host_dir = str(Path(host_script).parent.resolve())
    content = (
        "#!/bin/bash\n"
        f'DIR="{host_dir}"\n'
        'exec 2>>"$DIR/debug.log"\n'
        'export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"\n'
        f'exec "{python_path}" "$DIR/convert_and_save.py" "$@"\n'
    )
    Path(shell_path).write_text(content, encoding="utf-8")
    os.chmod(shell_path, 0o755)
    print(f"  Created shell wrapper: {shell_path}")


def create_windows_batch(batch_path, host_script):
    """Create a batch file wrapper for Windows."""
    python_path = get_python_path()
    content = f'@echo off\n"{python_path}" "{host_script}" %*\n'
    Path(batch_path).write_text(content, encoding="utf-8")
    print(f"  Created batch wrapper: {batch_path}")


def get_manifest_dir():
    """Get the OS-specific directory for Native Messaging Host manifests."""
    system = platform.system()

    if system == "Windows":
        return Path(__file__).parent / "host"
    elif system == "Darwin":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "Google"
            / "Chrome"
            / "NativeMessagingHosts"
        )
    else:
        return Path.home() / ".config" / "google-chrome" / "NativeMessagingHosts"


def install_windows_registry(manifest_path):
    """Register the Native Messaging Host in Windows registry."""
    try:
        import winreg

        key_path = f"SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
        print(f"  Registry key set: HKCU\\{key_path}")
        return True
    except Exception as e:
        print(f"  Failed to set registry: {e}")
        return False


def uninstall_windows_registry():
    """Remove the Native Messaging Host from Windows registry."""
    try:
        import winreg

        key_path = f"SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
        print(f"  Registry key removed: HKCU\\{key_path}")
        return True
    except FileNotFoundError:
        print("  Registry key not found (already uninstalled)")
        return True
    except Exception as e:
        print(f"  Failed to remove registry: {e}")
        return False


def install(extension_id):
    """Install the Native Messaging Host."""
    print(f"Installing Native Messaging Host: {HOST_NAME}")
    print(f"  Extension ID: {extension_id}")

    manifest = create_manifest(extension_id)
    manifest_dir = get_manifest_dir()
    manifest_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = manifest_dir / f"{HOST_NAME}.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(f"  Manifest written: {manifest_path}")

    # Make host script executable (Unix)
    if platform.system() != "Windows":
        host_script = Path(get_host_script_path())
        host_script.chmod(host_script.stat().st_mode | 0o755)

    # Windows: register in registry
    if platform.system() == "Windows":
        install_windows_registry(manifest_path)

    print("\nInstallation complete!")
    print("\nNext steps:")
    print("  1. Load the extension in Chrome (chrome://extensions)")
    print("  2. Copy the extension ID and re-run this script if it changed")
    print("  3. Set up host/.env with your ANTHROPIC_API_KEY")
    print("  4. Install Python dependencies: pip install -r host/requirements.txt")


def uninstall():
    """Uninstall the Native Messaging Host."""
    print(f"Uninstalling Native Messaging Host: {HOST_NAME}")

    manifest_dir = get_manifest_dir()
    manifest_path = manifest_dir / f"{HOST_NAME}.json"

    if manifest_path.exists():
        manifest_path.unlink()
        print(f"  Manifest removed: {manifest_path}")

    # Wrappers & binary
    for wrapper in ["run_host.bat", "run_host.sh", "native_host"]:
        wp = Path(__file__).parent / "host" / wrapper
        if wp.exists():
            wp.unlink()
            print(f"  Removed: {wp}")

    if platform.system() == "Windows":
        uninstall_windows_registry()

    print("\nUninstall complete!")


def main():
    parser = argparse.ArgumentParser(
        description="Install/uninstall LLM-to-Obsidian Native Messaging Host"
    )
    parser.add_argument(
        "--uninstall",
        action="store_true",
        help="Uninstall the Native Messaging Host",
    )
    parser.add_argument(
        "--extension-id",
        default="PLACEHOLDER_EXTENSION_ID",
        help="Chrome extension ID (get from chrome://extensions after loading)",
    )
    args = parser.parse_args()

    if args.uninstall:
        uninstall()
    else:
        if args.extension_id == "PLACEHOLDER_EXTENSION_ID":
            print("WARNING: Using placeholder extension ID.")
            print("After loading the extension in Chrome, re-run with:")
            print(f"  python install.py --extension-id YOUR_EXTENSION_ID\n")

        install(args.extension_id)


if __name__ == "__main__":
    main()
