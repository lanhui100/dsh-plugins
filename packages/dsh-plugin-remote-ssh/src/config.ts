/** Validated configuration for dsh-plugin-remote-ssh (Schemastery shape). */

export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Remote DSH web port on the far side of the tunnel. */
  remotePort: number
  /** Local loopback port the tunnel forwards to. */
  localPort: number
}
