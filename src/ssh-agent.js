'use strict';

/**
 * Minimal ssh-agent lifecycle for Terman.
 *
 * The problem it solves: every tab is its own process, so a passphrase-protected
 * key prompts once per tab. An agent holds the decrypted key in memory and every
 * ssh that can see SSH_AUTH_SOCK asks the agent instead of prompting. Terman runs
 * one agent and hands that variable to every PTY, so you unlock once per launch.
 *
 * Deliberately does NOT touch your passphrase. Unlocking happens by running
 * `ssh-add` in a normal terminal tab, so the prompt is a real tty prompt and the
 * secret never passes through Terman.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Where to look for ssh-agent / ssh-add, most specific first. */
function candidateDirs(hintDir) {
  const dirs = [];
  if (hintDir) dirs.push(hintDir);
  dirs.push('D:\\Utilities\\msys64\\usr\\bin');
  dirs.push('C:\\Program Files\\Git\\usr\\bin');
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (d) dirs.push(d);
  }
  return dirs;
}

function findBin(name, hintDir) {
  for (const dir of candidateDirs(hintDir)) {
    const p = path.join(dir, `${name}${EXE}`);
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* unreadable dir - keep looking */ }
  }
  return null;
}

class SshAgent {
  constructor(hintDir) {
    this.agentBin = findBin('ssh-agent', hintDir);
    this.addBin = findBin('ssh-add', hintDir);
    this.sock = null;
    this.pid = null;
    this.adopted = false;   // true when reusing an agent we didn't start
    this.error = null;
  }

  get available() {
    return !!(this.agentBin && this.addBin);
  }

  /**
   * Reuse an agent already in the environment if there is one, otherwise start
   * ours. Reusing matters: if the user already runs an agent, starting a second
   * one would mean unlocking twice for no reason.
   */
  start() {
    if (this.sock) return true;

    if (!this.available) {
      this.error = 'ssh-agent / ssh-add not found';
      return false;
    }

    const inherited = process.env.SSH_AUTH_SOCK;
    if (inherited) {
      this.sock = inherited;
      this.pid = process.env.SSH_AGENT_PID || null;
      this.adopted = true;
      this.error = null;
      return true;
    }

    // `ssh-agent -s` daemonizes and prints sh-style assignments, so a sync call
    // returns as soon as the agent is up.
    let res;
    try {
      res = spawnSync(this.agentBin, ['-s'], { encoding: 'utf8', windowsHide: true });
    } catch (err) {
      this.error = `could not run ssh-agent: ${err.message}`;
      return false;
    }

    const out = res.stdout || '';
    const sock = /SSH_AUTH_SOCK=([^;\s]+)/.exec(out);
    const pid = /SSH_AGENT_PID=(\d+)/.exec(out);
    if (!sock) {
      this.error = (res.stderr || '').trim() || 'ssh-agent produced no socket';
      return false;
    }

    this.sock = sock[1];
    this.pid = pid ? pid[1] : null;
    this.adopted = false;
    this.error = null;
    return true;
  }

  /** Merged into every PTY's environment. Empty when the agent isn't up. */
  env() {
    if (!this.sock) return {};
    const e = { SSH_AUTH_SOCK: this.sock };
    if (this.pid) e.SSH_AGENT_PID = this.pid;
    return e;
  }

  /**
   * `ssh-add -l` exit codes: 0 = has keys, 1 = reachable but empty, 2 = unreachable.
   * That 1-vs-2 distinction is the whole status check.
   */
  status() {
    if (!this.available) return { running: false, keyCount: 0, error: this.error || 'ssh-agent not found' };
    if (!this.sock) return { running: false, keyCount: 0, error: this.error };

    let res;
    try {
      res = spawnSync(this.addBin, ['-l'], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...this.env() },
      });
    } catch (err) {
      return { running: false, keyCount: 0, error: err.message };
    }

    if (res.status === 2) {
      return { running: false, keyCount: 0, error: 'agent not reachable' };
    }

    const keyCount = res.status === 0
      ? (res.stdout || '').split(/\r?\n/).filter((l) => l.trim()).length
      : 0;

    return { running: true, keyCount, adopted: this.adopted, error: null };
  }

  /**
   * What the renderer should spawn in a tab to unlock. Run as a normal PTY so the
   * passphrase prompt is a real tty prompt that Terman never sees.
   */
  unlockSpec(keys) {
    if (!this.available || !this.sock) return null;
    const args = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k.trim()) : [];
    return { exe: this.addBin, args };
  }

  /** Only kill agents we started; an adopted one belongs to someone else. */
  stop() {
    if (!this.sock || this.adopted) return;
    try {
      spawnSync(this.agentBin, ['-k'], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...this.env() },
      });
    } catch { /* going away anyway */ }
    this.sock = null;
    this.pid = null;
  }
}

module.exports = { SshAgent, findBin };
