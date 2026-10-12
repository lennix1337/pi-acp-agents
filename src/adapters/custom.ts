/**
 * pi-acp-agents — Custom ACP adapter for user-defined commands
 */
import { AcpAgentAdapter, type AcpAdapterOptions } from "./base.js";

export class CustomAcpAdapter extends AcpAgentAdapter {
  private readonly serverName: string;

  /** The configured server name (e.g. "agy"), so usage and activity are attributed to it. */
  get name(): string {
    return this.serverName;
  }

  constructor(opts: AcpAdapterOptions) {
    super(opts);
    this.serverName = opts.agentName ?? "custom";
  }
}
