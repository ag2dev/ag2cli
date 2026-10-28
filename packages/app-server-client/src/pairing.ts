import type {
  AppServerPairClaimParams,
  AppServerPairClaimResult,
  AppServerPairCreateParams,
  AppServerPairCreateResult,
  AppServerPairPreviewResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { VerifiedAppServerConnection } from "./verified-connection.js"

/** Pairing methods that require the same connection object that verified Host preflight. */
export class AppServerPairingClient {
  constructor(private readonly connection: VerifiedAppServerConnection) {}

  async create(params: AppServerPairCreateParams): Promise<AppServerPairCreateResult> {
    return this.connection.createPairing(params)
  }

  async preview(pairingToken: string): Promise<AppServerPairPreviewResult> {
    return this.connection.previewPairing(pairingToken)
  }

  async claim(params: AppServerPairClaimParams): Promise<AppServerPairClaimResult> {
    return this.connection.claimPairing(params)
  }
}
