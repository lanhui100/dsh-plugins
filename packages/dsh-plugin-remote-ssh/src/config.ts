/** Validated configuration for dsh-plugin-remote-ssh (Schemastery shape). */

export interface Config {
  /**
   * Optional OpenSSH host alias registered at startup (including its existing
   * user, key and known-host configuration). When omitted, no host is
   * pre-registered: remote hosts are added dynamically through the
   * `POST /remote-ssh/add-host` flow (workspace header button / settings
   * panel) and persisted across restarts in `$DSH_HOME/remote-ssh-hosts.json`.
   */
  host?: string
  /** Remote DSH web port on the far side of the tunnel. */
  remotePort: number
  /** Local loopback port the tunnel forwards to. */
  localPort: number
}
