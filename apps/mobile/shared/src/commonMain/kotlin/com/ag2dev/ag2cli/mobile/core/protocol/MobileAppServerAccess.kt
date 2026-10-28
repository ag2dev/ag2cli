package com.ag2dev.ag2cli.mobile.core.protocol

enum class MobileAppServerOperation(
    val capability: String,
    val requiredScope: AppServerScope? = null,
) {
    // Connection-level methods are not capability-gated; session faces are
    // advertised through the structured session.methods group and workspace
    // faces through boolean capability flags.
    SERVER_DESCRIBE("server.describe"),
    SERVER_HEALTH("server.health"),
    SESSION_CREATE("session.create", AppServerScope.SESSION_WRITE),
    SESSION_LIST("session.list", AppServerScope.SESSION_READ),
    SESSION_GET("session.get", AppServerScope.SESSION_READ),
    SESSION_ATTACH("session.attach", AppServerScope.SESSION_READ),
    SESSION_DETACH("session.detach", AppServerScope.SESSION_READ),
    SESSION_SNAPSHOT("session.snapshot", AppServerScope.SESSION_READ),
    SESSION_REPLAY("session.replay", AppServerScope.SESSION_READ),
    SESSION_RESYNC("session.resync", AppServerScope.SESSION_READ),
    SESSION_TRACE("session.trace", AppServerScope.SESSION_READ),
    SESSION_MODEL_CALLS("session.modelCalls", AppServerScope.SESSION_READ),
    SESSION_SUBMIT("session.submit", AppServerScope.SESSION_WRITE),
    SESSION_CANCEL_RUN("session.cancelRun", AppServerScope.SESSION_WRITE),
    SESSION_STEER("session.steer", AppServerScope.SESSION_WRITE),
    SESSION_CANCEL_INPUT("session.cancelInput", AppServerScope.SESSION_WRITE),
    SESSION_RESOLVE_INTERACTION("session.resolveInteraction", AppServerScope.SESSION_WRITE),
    SESSION_PLAN("session.plan", AppServerScope.SESSION_WRITE),
    SESSION_GET_PERMISSION_POLICY("session.getPermissionPolicy", AppServerScope.SESSION_POLICY),
    SESSION_SET_PERMISSION_MODE("session.setPermissionMode", AppServerScope.SESSION_POLICY),
    SESSION_SET_PERMISSION_RULES("session.setPermissionRules", AppServerScope.SESSION_POLICY),
    WORKSPACE_DIFF("workspace.diff", AppServerScope.WORKSPACE_READ),
    WORKSPACE_READ_FILE("workspace.readFile", AppServerScope.WORKSPACE_READ),
    INTERACTION_ACQUIRE("interaction.acquire", AppServerScope.SESSION_WRITE),
    INTERACTION_RENEW("interaction.renew", AppServerScope.SESSION_WRITE),
    INTERACTION_RELEASE("interaction.release", AppServerScope.SESSION_WRITE),
    INTERACTION_TAKEOVER("interaction.takeover", AppServerScope.SESSION_WRITE),
}

fun ServerInitializeResult.allows(operation: MobileAppServerOperation): Boolean {
    // The server advertises workspace faces only via boolean flags; they never
    // appear in session.methods, so a methods lookup would always deny them.
    val advertised = when (operation) {
        MobileAppServerOperation.WORKSPACE_DIFF -> capabilities.workspace.diff
        MobileAppServerOperation.WORKSPACE_READ_FILE -> capabilities.workspace.readFile
        MobileAppServerOperation.SERVER_DESCRIBE, MobileAppServerOperation.SERVER_HEALTH -> true
        else -> operation.capability in capabilities.session.methods
    }
    return advertised && (operation.requiredScope == null || operation.requiredScope in connection.scopes)
}
