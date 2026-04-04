#!/usr/bin/env python3
"""
Run a subprocess with a new pseudo-terminal as its controlling tty.
Used so relayer-cli can open /dev/tty for mnemonic output when the dashboard
has no TTY (piped stdio from Node).

Usage: relayer-pty-helper.py <cwd> <program> [arg ...]
All captured pty output is written to this process's stdout (bytes).
Exit status is the child's exit status (or 1 on spawn failure).
"""
from __future__ import annotations

import os
import pty
import sys


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: relayer-pty-helper.py <cwd> <program> [arg ...]", file=sys.stderr)
        sys.exit(2)
    cwd = args[0]
    exec_argv = args[1:]
    if not exec_argv:
        print("relayer-pty-helper: missing program", file=sys.stderr)
        sys.exit(2)
    try:
        os.chdir(cwd)
    except OSError as e:
        print(f"relayer-pty-helper: chdir: {e}", file=sys.stderr)
        sys.exit(1)

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: controlling tty is already the pty slave.
        try:
            os.execvp(exec_argv[0], exec_argv)
        except OSError as e:
            print(f"relayer-pty-helper: exec: {e}", file=sys.stderr)
            sys.exit(127)
        return

    out: list[bytes] = []
    try:
        while True:
            chunk = os.read(master_fd, 65536)
            if not chunk:
                break
            out.append(chunk)
    except OSError:
        pass
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(b"".join(out))
    if os.WIFEXITED(status):
        sys.exit(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(1)


if __name__ == "__main__":
    main()
