@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)

package com.ag2dev.ag2cli.mobile.core.protocol

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.longOrNull

const val APP_SERVER_PROTOCOL_VERSION: Int = 1

val appServerJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = false
    allowSpecialFloatingPointValues = false
}

@Serializable
enum class AppServerClientKind {
    @SerialName("tui") TUI,
    @SerialName("web") WEB,
    @SerialName("mobile") MOBILE,
    @SerialName("desktop") DESKTOP,
    @SerialName("acp") ACP,
    @SerialName("script") SCRIPT,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
enum class AppServerScope {
    @SerialName("session:read") SESSION_READ,
    @SerialName("session:write") SESSION_WRITE,
    @SerialName("approval:write") APPROVAL_WRITE,
    @SerialName("shell:execute") SHELL_EXECUTE,
    @SerialName("config:read") CONFIG_READ,
    @SerialName("config:write") CONFIG_WRITE,
    @SerialName("device:admin") DEVICE_ADMIN,
    @SerialName("session:policy") SESSION_POLICY,
    @SerialName("workspace:read") WORKSPACE_READ,
}

@Serializable
data class AppServerClientInfo(
    val clientId: String,
    val clientKind: AppServerClientKind,
    val name: String,
    val version: String,
    val capabilities: List<String>? = null,
)

@Serializable
data class AppServerDeviceProof(
    val deviceId: String,
    val challenge: String,
    val signature: String,
) {
    override fun toString(): String = "AppServerDeviceProof(deviceId=$deviceId, challenge=<redacted>, signature=<redacted>)"
}

@Serializable
data class AppServerDeviceChallenge(
    val challenge: String,
    val hostId: String,
    val expiresAt: Long,
) {
    override fun toString(): String = "AppServerDeviceChallenge(challenge=<redacted>, hostId=$hostId, expiresAt=$expiresAt)"
}

@Serializable
data class AppServerDeviceAuth(
    val deviceId: String,
    val challenge: String,
    val signature: String,
    val credential: String,
) {
    override fun toString(): String =
        "AppServerDeviceAuth(deviceId=$deviceId, challenge=<redacted>, signature=<redacted>, credential=<redacted>)"
}

@Serializable
sealed interface ServerInitializeAuth

@Serializable
@SerialName("device")
data class DeviceServerInitializeAuth(val device: AppServerDeviceAuth) : ServerInitializeAuth

@Serializable
@SerialName("operator")
data class OperatorServerInitializeAuth(val bearerToken: String) : ServerInitializeAuth {
    override fun toString(): String = "OperatorServerInitializeAuth(bearerToken=<redacted>)"
}

@Serializable
data class AppServerDeviceRecord(
    val deviceId: String,
    val name: String,
    val clientKind: AppServerClientKind,
    val scopes: List<AppServerScope>,
    val publicKey: String? = null,
    val createdAt: String,
    val revokedAt: String? = null,
)

@Serializable
data class AppServerDeviceRegistration(
    val device: AppServerDeviceRecord,
    val credential: String,
) {
    override fun toString(): String = "AppServerDeviceRegistration(deviceId=${device.deviceId}, credential=<redacted>)"
}

@Serializable
data class AppServerPairClaimParams(
    val pairingToken: String,
    val name: String,
    val clientKind: AppServerClientKind,
    val publicKey: String,
) {
    override fun toString(): String =
        "AppServerPairingClaimRequest(pairingToken=<redacted>, name=$name, clientKind=$clientKind, publicKey=<redacted>)"
}

@Serializable
data class AppServerPairCreateParams(
    val scopes: List<AppServerScope>,
    val ttlMs: Long? = null,
)

@Serializable
data class AppServerPairCreateResult(
    val pairingToken: String,
    val hostId: String,
    val scopes: List<AppServerScope>,
    val expiresAt: String,
) {
    override fun toString(): String = "AppServerPairCreateResult(pairingToken=<redacted>, hostId=$hostId, scopes=$scopes, expiresAt=$expiresAt)"
}

@Serializable
data class AppServerPairPreviewParams(val pairingToken: String) {
    override fun toString(): String = "AppServerPairPreviewParams(pairingToken=<redacted>)"
}

@Serializable
data class AppServerPairPreviewResult(
    val hostId: String,
    val scopes: List<AppServerScope>,
    val expiresAt: String,
)

@Serializable
data class RecoveryCursor(
    val sessionId: String? = null,
    val afterRevision: Long? = null,
)

@Serializable
enum class AppServerResyncReason {
    @SerialName("queue_overflow") QUEUE_OVERFLOW,
    @SerialName("restart") RESTART,
    @SerialName("rewind") REWIND,
    @SerialName("history_unavailable") HISTORY_UNAVAILABLE,
}

@Serializable
data class AppServerResyncRequiredNotification(
    val sessionId: String,
    val minimumRevision: Long,
    val reason: AppServerResyncReason,
)

@Serializable
data class ServerInitializeParams(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val appServerProtocolVersion: Int = APP_SERVER_PROTOCOL_VERSION,
    val hostId: String,
    val client: AppServerClientInfo,
    val auth: ServerInitializeAuth,
    val requestedScopes: List<AppServerScope>? = null,
    val recovery: RecoveryCursor? = null,
    val clientCapabilities: AppServerCapabilities? = null,
)

@Serializable
data class AppServerDescriptor(
    val name: String,
    val version: String,
    val hostId: String,
    val protocolVersion: Int,
)

@Serializable
data class AppServerConnection(
    val connectionId: String,
    val deviceId: String? = null,
    val scopes: List<AppServerScope>,
)

/** Structured server capabilities: advertisement only; scopes, policy and leases decide authorization. */
@Serializable
data class AppServerCapabilities(
    val session: AppServerSessionCapabilities,
    val interactions: AppServerInteractionCapabilities,
    val workspace: AppServerWorkspaceCapabilities,
    val security: AppServerSecurityCapabilities,
    val execution: AppServerExecutionCapabilities,
)

@Serializable
data class AppServerSessionCapabilities(
    val methods: List<String>,
    val eventTypes: List<String>,
)

@Serializable
data class AppServerInteractionCapabilities(
    val approval: Boolean,
    val askUser: Boolean,
    val elicitationForms: Boolean? = null,
)

@Serializable
data class AppServerWorkspaceCapabilities(
    val diff: Boolean,
    val readFile: Boolean,
    val searchFiles: Boolean? = null,
)

@Serializable
data class AppServerSecurityCapabilities(
    val permissionModes: List<String>,
    val editableRules: Boolean,
)

@Serializable
data class AppServerExecutionCapabilities(
    val explicitShell: Boolean,
    val terminalDisplay: Boolean? = null,
)

@Serializable
data class AppServerPairClaimResult(
    val device: AppServerDeviceRecord,
    val credential: String,
) {
    override fun toString(): String = "AppServerPairClaimResult(deviceId=${device.deviceId}, credential=<redacted>)"
}

@Serializable
enum class AppServerHostProfile {
    @SerialName("durable") DURABLE,
    @SerialName("ephemeral") EPHEMERAL,
}

@Serializable
enum class WorkspaceAvailability {
    @SerialName("available") AVAILABLE,
    @SerialName("unavailable") UNAVAILABLE,
}

@Serializable
data class AppServerWorkspace(
    val workspaceId: String,
    val workspaceRoot: String,
    val availability: WorkspaceAvailability,
)

@Serializable
data class AppServerHost(
    val profile: AppServerHostProfile,
    val workspaceRoot: String? = null,
    val workspaces: List<AppServerWorkspace>? = null,
    val configurationFingerprint: String? = null,
    val workspaceFingerprint: String? = null,
    val securityFingerprint: String? = null,
)

@Serializable
data class ServerInitializeResult(
    val appServerProtocolVersion: Int,
    val server: AppServerDescriptor,
    val connection: AppServerConnection,
    val capabilities: AppServerCapabilities,
    val host: AppServerHost? = null,
)

@Serializable
data class ServerDescribeResult(
    val server: AppServerDescriptor,
    val capabilities: AppServerCapabilities,
)

@Serializable
data class JsonRpcRequest(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val jsonrpc: String = "2.0",
    val id: Long,
    val method: String,
    val params: JsonElement? = null,
)

@Serializable
data class JsonRpcNotification(
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val jsonrpc: String = "2.0",
    val method: String,
    val params: JsonElement? = null,
)

data class JsonRpcFailure(
    val code: Long,
    val message: String,
    val kind: String? = null,
    val retryable: Boolean = false,
    val details: JsonElement? = null,
)

class AppServerProtocolException(
    val kind: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

class AppServerRpcException(
    val code: Long,
    val kind: String?,
    val retryable: Boolean,
    val details: JsonElement?,
    message: String,
) : Exception(message)

fun decodeServerInitializeResult(value: JsonElement): ServerInitializeResult {
    val objectValue = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_result", "server.initialize result must be an object")
    val versionedObject = normalizeProtocolVersion(objectValue, "appServerProtocolVersion")
    val serverObject = versionedObject["server"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_result", "server.initialize result.server must be an object")
    requireFields(serverObject, setOf("name", "version", "hostId", "protocolVersion"), "server.initialize.result.server", "invalid_result")
    (versionedObject["connection"] as? JsonObject)?.let {
        requireFields(it, setOf("connectionId", "deviceId", "scopes"), "server.initialize.result.connection", "invalid_result")
    }
    val normalizedServer = normalizeProtocolVersion(serverObject, "protocolVersion")
    val normalizedValue = JsonObject(versionedObject + ("server" to normalizedServer))
    requireFields(normalizedValue, setOf("appServerProtocolVersion", "server", "connection", "capabilities", "host"), "server.initialize.result", "invalid_result")
    requireCapabilitiesFields(normalizedValue, "capabilities", "server.initialize.result.capabilities", "invalid_result")
    rejectOptionalNullsInServerInitializeResult(normalizedValue)
    val result = try {
        appServerJson.decodeFromJsonElement<ServerInitializeResult>(normalizedValue)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_result", "Invalid server.initialize result: ${error.message}")
    }
    validateServerInitializeResult(result)
    return result.copy(connection = result.connection.copy(scopes = result.connection.scopes.distinct()))
}

fun decodeServerInitializeParams(value: JsonElement): ServerInitializeParams {
    val objectValue = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "server.initialize params must be an object")
    val versionedValue = normalizeProtocolVersion(objectValue, "appServerProtocolVersion")
    val normalizedValue = normalizeRecoveryAfterRevision(versionedValue)
    requireFields(normalizedValue, setOf("appServerProtocolVersion", "hostId", "client", "auth", "requestedScopes", "recovery", "clientCapabilities"), "server.initialize.params", "invalid_params")
    (normalizedValue["clientCapabilities"] as? JsonObject)?.let {
        requireCapabilitiesFields(normalizedValue, "clientCapabilities", "server.initialize.params.clientCapabilities", "invalid_params")
    }
    (normalizedValue["client"] as? JsonObject)?.let {
        requireFields(it, setOf("clientId", "clientKind", "name", "version", "capabilities"), "server.initialize.params.client", "invalid_params")
    }
    val auth = normalizedValue["auth"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "server.initialize.params.auth must be an object")
    when ((auth["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
        "device" -> {
            requireFields(auth, setOf("type", "device"), "server.initialize.params.auth", "invalid_params")
            (auth["device"] as? JsonObject)?.let {
                requireFields(it, setOf("deviceId", "challenge", "signature", "credential"), "server.initialize.params.auth.device", "invalid_params")
            }
        }
        "operator" -> requireFields(auth, setOf("type", "bearerToken"), "server.initialize.params.auth", "invalid_params")
        else -> throw AppServerProtocolException("invalid_params", "server.initialize.params.auth.type is invalid")
    }
    (normalizedValue["recovery"] as? JsonObject)?.let {
        requireFields(it, setOf("sessionId", "afterRevision"), "server.initialize.params.recovery", "invalid_params")
    }
    rejectOptionalNullsInServerInitializeParams(normalizedValue)
    val params = try {
        appServerJson.decodeFromJsonElement<ServerInitializeParams>(normalizedValue)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_params", "Invalid server.initialize params: ${error.message}")
    }
    validateServerInitializeParams(params)
    return params.copy(requestedScopes = params.requestedScopes?.distinct())
}

fun decodeServerDescribeResult(value: JsonElement): ServerDescribeResult {
    val objectValue = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_result", "server.describe result must be an object")
    val serverObject = objectValue["server"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_result", "server.describe result.server must be an object")
    requireFields(serverObject, setOf("name", "version", "hostId", "protocolVersion"), "server.describe.result.server", "invalid_result")
    val normalizedServer = normalizeProtocolVersion(serverObject, "protocolVersion")
    val normalizedValue = JsonObject(objectValue + ("server" to normalizedServer))
    requireFields(normalizedValue, setOf("server", "capabilities"), "server.describe.result", "invalid_result")
    requireCapabilitiesFields(normalizedValue, "capabilities", "server.describe.result.capabilities", "invalid_result")
    val result = try {
        appServerJson.decodeFromJsonElement<ServerDescribeResult>(normalizedValue)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_result", "Invalid server.describe result: ${error.message}")
    }
    requireWireString(result.server.name, "server.name", "invalid_result")
    requireWireString(result.server.version, "server.version", "invalid_result")
    if (!isValidAppServerHostId(result.server.hostId)) {
        throw AppServerProtocolException("invalid_result", "server.hostId has an invalid format")
    }
    validateAppServerCapabilities(result.capabilities, "capabilities", "invalid_result")
    return result
}

private fun requireCapabilitiesFields(value: JsonObject, field: String, path: String, errorKind: String) {
    val capabilities = value[field] as? JsonObject
        ?: throw AppServerProtocolException(errorKind, "$path must be an object")
    requireFields(capabilities, setOf("session", "interactions", "workspace", "security", "execution"), path, errorKind)
    (capabilities["session"] as? JsonObject)?.let {
        requireFields(it, setOf("methods", "eventTypes"), "$path.session", errorKind)
    }
    (capabilities["interactions"] as? JsonObject)?.let {
        requireFields(it, setOf("approval", "askUser", "elicitationForms"), "$path.interactions", errorKind)
    }
    (capabilities["workspace"] as? JsonObject)?.let {
        requireFields(it, setOf("diff", "readFile", "searchFiles"), "$path.workspace", errorKind)
    }
    (capabilities["security"] as? JsonObject)?.let {
        requireFields(it, setOf("permissionModes", "editableRules"), "$path.security", errorKind)
    }
    (capabilities["execution"] as? JsonObject)?.let {
        requireFields(it, setOf("explicitShell", "terminalDisplay"), "$path.execution", errorKind)
    }
}

private fun validateAppServerCapabilities(capabilities: AppServerCapabilities, path: String, errorKind: String) {
    capabilities.session.methods.forEachIndexed { index, method ->
        requireWireString(method, "$path.session.methods[$index]", errorKind)
    }
    capabilities.session.eventTypes.forEachIndexed { index, eventType ->
        requireWireString(eventType, "$path.session.eventTypes[$index]", errorKind)
    }
    capabilities.security.permissionModes.forEachIndexed { index, mode ->
        requireWireString(mode, "$path.security.permissionModes[$index]", errorKind)
    }
}

private fun normalizeRecoveryAfterRevision(value: JsonObject): JsonObject {
    val recovery = value["recovery"] as? JsonObject ?: return value
    val rawRevision = recovery["afterRevision"] as? JsonPrimitive ?: return value
    val numericRevision = rawRevision.takeIf { !it.isString }?.doubleOrNull ?: return value
    if (
        !numericRevision.isFinite() ||
        numericRevision < 0.0 ||
        numericRevision > MAX_SAFE_INTEGER.toDouble() ||
        numericRevision % 1.0 != 0.0
    ) {
        return value
    }
    val normalizedRecovery = JsonObject(recovery + ("afterRevision" to JsonPrimitive(numericRevision.toLong())))
    return JsonObject(value + ("recovery" to normalizedRecovery))
}

private fun normalizeProtocolVersion(value: JsonObject, field: String): JsonObject {
    val rawVersion = value[field] as? JsonPrimitive
    val numericVersion = rawVersion?.takeIf { !it.isString }?.doubleOrNull
    if (numericVersion != APP_SERVER_PROTOCOL_VERSION.toDouble()) {
        val label = if (field == "protocolVersion") "Server descriptor protocol major version" else "App Server protocol major version"
        throw AppServerProtocolException(
            "protocol_version_mismatch",
            "$label is unsupported: ${rawVersion?.content ?: "missing or invalid"}",
        )
    }
    return JsonObject(value + (field to JsonPrimitive(APP_SERVER_PROTOCOL_VERSION)))
}

private fun rejectOptionalNullsInServerInitializeParams(value: JsonObject) {
    rejectOptionalNulls(value, setOf("requestedScopes", "recovery", "clientCapabilities"), "server.initialize.params", "invalid_params")
    (value["client"] as? JsonObject)?.let { client ->
        rejectOptionalNulls(client, setOf("capabilities"), "server.initialize.params.client", "invalid_params")
    }
    (value["auth"] as? JsonObject)?.let { auth ->
        rejectOptionalNulls(auth, setOf("device", "bearerToken"), "server.initialize.params.auth", "invalid_params")
        (auth["device"] as? JsonObject)?.let { device ->
            rejectOptionalNulls(device, emptySet(), "server.initialize.params.auth.device", "invalid_params")
        }
    }
    (value["recovery"] as? JsonObject)?.let { recovery ->
        rejectOptionalNulls(recovery, setOf("sessionId", "afterRevision"), "server.initialize.params.recovery", "invalid_params")
    }
}

private fun rejectOptionalNullsInServerInitializeResult(value: JsonObject) {
    rejectOptionalNulls(value, setOf("host"), "server.initialize.result", "invalid_result")
    (value["host"] as? JsonObject)?.let { host ->
        rejectOptionalNulls(
            host,
            setOf("workspaceRoot", "workspaces", "configurationFingerprint", "workspaceFingerprint", "securityFingerprint"),
            "server.initialize.result.host",
            "invalid_result",
        )
    }
}

private fun requireFields(value: JsonObject, allowed: Set<String>, path: String, errorKind: String) {
    val unknown = value.keys.firstOrNull { it !in allowed } ?: return
    throw AppServerProtocolException(errorKind, "$path.$unknown is an unknown field")
}

private fun rejectOptionalNulls(value: JsonObject, fields: Set<String>, path: String, errorKind: String) {
    val field = fields.firstOrNull { value[it] == JsonNull } ?: return
    throw AppServerProtocolException(errorKind, "$path.$field must be omitted when absent")
}

fun decodeServerPreflightParams(value: JsonElement): ServerPreflightParams {
    if (value !is JsonObject) {
        throw AppServerProtocolException("invalid_params", "server.preflight params must be an object")
    }
    val unknownField = value.keys.firstOrNull { it != "nonce" && it != "purpose" }
    if (unknownField != null) {
        throw AppServerProtocolException("invalid_params", "server.preflight.params.$unknownField is an unknown field")
    }
    val params = try {
        appServerJson.decodeFromJsonElement<ServerPreflightParams>(value)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_params", "Invalid server.preflight params: ${error.message}")
    }
    if (!isValidAppServerHostProofNonce(params.nonce)) {
        throw AppServerProtocolException("invalid_params", "server.preflight nonce has an invalid format")
    }
    return params
}

fun decodeServerPreflightResult(value: JsonElement): ServerPreflightResult {
    if (value !is JsonObject) {
        throw AppServerProtocolException("invalid_result", "server.preflight result must be an object")
    }
    requireFields(
        value,
        setOf("hostId", "hostPublicKey", "nonce", "purpose", "expiresAt", "signature", "deviceChallenge", "deviceChallengeExpiresAt"),
        "server.preflight.result",
        "invalid_result",
    )
    val result = try {
        appServerJson.decodeFromJsonElement<ServerPreflightResult>(value)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_result", "Invalid server.preflight result: ${error.message}")
    }
    validateServerPreflightResult(result, value)
    return result
}

fun decodeAppServerPairCreateResult(value: JsonElement): AppServerPairCreateResult {
    val result = value as? JsonObject ?: throw AppServerProtocolException("invalid_result", "pair.create result must be an object")
    requireFields(result, setOf("pairingToken", "hostId", "scopes", "expiresAt"), "pair.create.result", "invalid_result")
    val decoded = decodePairResult<AppServerPairCreateResult>(result, "pair.create")
    validatePairingToken(decoded.pairingToken, "pair.create.result.pairingToken")
    validateHostId(decoded.hostId, "pair.create.result.hostId")
    validatePairingScopes(decoded.scopes, "pair.create.result.scopes")
    requireWireString(decoded.expiresAt, "pair.create.result.expiresAt", "invalid_result")
    return decoded.copy(scopes = decoded.scopes.distinct())
}

fun decodeAppServerPairPreviewResult(value: JsonElement): AppServerPairPreviewResult {
    val result = value as? JsonObject ?: throw AppServerProtocolException("invalid_result", "pair.preview result must be an object")
    requireFields(result, setOf("hostId", "scopes", "expiresAt"), "pair.preview.result", "invalid_result")
    val decoded = decodePairResult<AppServerPairPreviewResult>(result, "pair.preview")
    validateHostId(decoded.hostId, "pair.preview.result.hostId")
    validatePairingScopes(decoded.scopes, "pair.preview.result.scopes")
    requireWireString(decoded.expiresAt, "pair.preview.result.expiresAt", "invalid_result")
    return decoded.copy(scopes = decoded.scopes.distinct())
}

fun decodeAppServerPairClaimResult(value: JsonElement): AppServerPairClaimResult {
    val result = value as? JsonObject ?: throw AppServerProtocolException("invalid_result", "pair.claim result must be an object")
    requireFields(result, setOf("device", "credential"), "pair.claim.result", "invalid_result")
    val device = result["device"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_result", "pair.claim.result.device must be an object")
    requireFields(device, setOf("deviceId", "name", "clientKind", "scopes", "publicKey", "createdAt", "revokedAt"), "pair.claim.result.device", "invalid_result")
    val decoded = decodePairResult<AppServerPairClaimResult>(result, "pair.claim")
    validateCredential(decoded.credential, "pair.claim.result.credential")
    requireWireString(decoded.device.deviceId, "pair.claim.result.device.deviceId", "invalid_result")
    requireWireString(decoded.device.name, "pair.claim.result.device.name", "invalid_result")
    requireWireString(decoded.device.createdAt, "pair.claim.result.device.createdAt", "invalid_result")
    decoded.device.publicKey?.let {
        if (!isValidDevicePublicKey(it)) throw AppServerProtocolException("invalid_result", "pair.claim.result.device.publicKey has an invalid format")
    }
    validatePairingScopes(decoded.device.scopes, "pair.claim.result.device.scopes")
    return decoded.copy(device = decoded.device.copy(scopes = decoded.device.scopes.distinct()))
}

private inline fun <reified T> decodePairResult(value: JsonElement, method: String): T = try {
    appServerJson.decodeFromJsonElement<T>(value)
} catch (error: IllegalArgumentException) {
    throw AppServerProtocolException("invalid_result", "Invalid $method result: ${error.message}")
}

/** Methods without a params body accept an absent or empty object on the wire. */
fun decodeNoParams(value: JsonElement, method: String): JsonObject {
    val empty = value is JsonNull || (value as? JsonObject)?.isEmpty() == true
    if (!empty) throw AppServerProtocolException("invalid_params", "$method params must be empty")
    return JsonObject(emptyMap())
}

fun decodeServerHealthParams(value: JsonElement): JsonObject = decodeNoParams(value, "server.health")

fun decodeServerDescribeParams(value: JsonElement): JsonObject = decodeNoParams(value, "server.describe")

fun decodeDeviceListParams(value: JsonElement): JsonObject = decodeNoParams(value, "device.list")

@Serializable
data class DeviceRevokeParams(val deviceId: String)

fun decodeDeviceRevokeParams(value: JsonElement): DeviceRevokeParams {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "device.revoke params must be an object")
    return DeviceRevokeParams(params.requiredString("deviceId", "invalid_params"))
}

fun decodeAppServerPairCreateParams(value: JsonElement): AppServerPairCreateParams {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "pair.create params must be an object")
    requireFields(params, setOf("scopes", "ttlMs"), "pair.create.params", "invalid_params")
    val scopes = params["scopes"]?.let { decodeScopeList(it, "pair.create.params.scopes") }
        ?: throw AppServerProtocolException("invalid_params", "pair.create.params.scopes is required")
    if (scopes.isEmpty() || scopes.any { it !in PAIRING_SCOPES }) {
        throw AppServerProtocolException("invalid_params", "pair.create.params.scopes must contain only pairable scopes")
    }
    val ttlMs = params["ttlMs"]?.let {
        requireBoundedInteger(it, "pair.create.params.ttlMs", PAIRING_TTL_MIN_MS, PAIRING_TTL_MAX_MS, "invalid_params")
    }
    return AppServerPairCreateParams(scopes, ttlMs)
}

fun decodeAppServerPairPreviewParams(value: JsonElement): AppServerPairPreviewParams {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "pair.preview params must be an object")
    requireFields(params, setOf("pairingToken"), "pair.preview.params", "invalid_params")
    val pairingToken = params.requiredString("pairingToken", "invalid_params")
    if (!PAIRING_TOKEN_PATTERN.matches(pairingToken)) {
        throw AppServerProtocolException("invalid_params", "pair.preview.params.pairingToken has an invalid format")
    }
    return AppServerPairPreviewParams(pairingToken)
}

fun decodeAppServerPairClaimParams(value: JsonElement): AppServerPairClaimParams {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "pair.claim params must be an object")
    requireFields(params, setOf("pairingToken", "name", "clientKind", "publicKey"), "pair.claim.params", "invalid_params")
    val clientKind = params.requiredString("clientKind", "invalid_params")
    if (clientKind != "mobile" && clientKind != "web") {
        throw AppServerProtocolException("invalid_params", "pair.claim.params.clientKind must be web or mobile")
    }
    val publicKey = params.requiredString("publicKey", "invalid_params")
    if (!isValidDevicePublicKey(publicKey)) {
        throw AppServerProtocolException("invalid_params", "pair.claim.params.publicKey has an invalid format")
    }
    val pairingToken = params.requiredString("pairingToken", "invalid_params")
    if (!PAIRING_TOKEN_PATTERN.matches(pairingToken)) {
        throw AppServerProtocolException("invalid_params", "pair.claim.params.pairingToken has an invalid format")
    }
    return AppServerPairClaimParams(
        pairingToken = pairingToken,
        name = params.requiredString("name", "invalid_params"),
        clientKind = if (clientKind == "mobile") AppServerClientKind.MOBILE else AppServerClientKind.WEB,
        publicKey = publicKey,
    )
}

@Serializable
data class SessionListParams(val workspaceId: String? = null)

fun decodeSessionListParams(value: JsonElement): SessionListParams {
    val params = when (value) {
        is JsonObject -> value
        is JsonNull -> return SessionListParams()
        else -> throw AppServerProtocolException("invalid_params", "session.list params must be an object")
    }
    requireFields(params, setOf("workspaceId"), "session.list.params", "invalid_params")
    return SessionListParams(params.optionalWireString("workspaceId", "session.list.params.workspaceId"))
}

@Serializable
data class SessionIdParams(val sessionId: String)

fun decodeSessionIdParams(value: JsonElement, method: String): SessionIdParams {
    val params = paramsObject(value, method)
    requireFields(params, setOf("sessionId"), "$method.params", "invalid_params")
    return SessionIdParams(params.requiredString("sessionId", "invalid_params"))
}

@Serializable
data class SessionAttachParams(val sessionId: String, val includeRecentMessages: Long? = null)

fun decodeSessionAttachParams(value: JsonElement): SessionAttachParams {
    val params = paramsObject(value, "session.attach")
    requireFields(params, setOf("sessionId", "includeRecentMessages"), "session.attach.params", "invalid_params")
    val includeRecentMessages = params["includeRecentMessages"]?.let {
        requireBoundedInteger(it, "session.attach.params.includeRecentMessages", 1, MAX_INCLUDE_RECENT_MESSAGES, "invalid_params")
    }
    return SessionAttachParams(params.requiredString("sessionId", "invalid_params"), includeRecentMessages)
}

@Serializable
data class SessionReplayParams(
    val sessionId: String,
    val afterRevision: Long,
    val limit: Long? = null,
    val maxBytes: Long? = null,
)

fun decodeSessionReplayParams(value: JsonElement): SessionReplayParams {
    val params = paramsObject(value, "session.replay")
    requireFields(params, setOf("sessionId", "afterRevision", "limit", "maxBytes"), "session.replay.params", "invalid_params")
    val afterRevision = params.requiredLong("afterRevision", "invalid_params")
    if (afterRevision < 0) {
        throw AppServerProtocolException("invalid_params", "session.replay.params.afterRevision must be a non-negative integer")
    }
    val limit = params["limit"]?.let {
        requireBoundedInteger(it, "session.replay.params.limit", 1, MAX_REPLAY_LIMIT, "invalid_params")
    }
    val maxBytes = params["maxBytes"]?.let {
        requireBoundedInteger(it, "session.replay.params.maxBytes", 1, MAX_REPLAY_MAX_BYTES, "invalid_params")
    }
    return SessionReplayParams(params.requiredString("sessionId", "invalid_params"), afterRevision, limit, maxBytes)
}

@Serializable
data class SessionCreateParams(val sessionId: String, val workspaceId: String, val title: String? = null)

fun decodeSessionCreateParams(value: JsonElement): SessionCreateParams {
    val params = paramsObject(value, "session.create")
    requireFields(params, setOf("sessionId", "workspaceId", "title"), "session.create.params", "invalid_params")
    return SessionCreateParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        workspaceId = params.requiredString("workspaceId", "invalid_params"),
        title = params.optionalWireString("title", "session.create.params.title"),
    )
}

@Serializable
data class SessionControlLeaseRefParams(val scope: String, val generation: Long)

@Serializable
data class SessionForkParams(
    val sourceSessionId: String,
    val targetSessionId: String? = null,
    val title: String? = null,
    val lease: SessionControlLeaseRefParams? = null,
)

fun decodeSessionForkParams(value: JsonElement): SessionForkParams {
    val params = paramsObject(value, "session.fork")
    requireFields(
        params,
        setOf("sourceSessionId", "targetSessionId", "title", "lease"),
        "session.fork.params",
        "invalid_params",
    )
    return SessionForkParams(
        sourceSessionId = params.requiredString("sourceSessionId", "invalid_params"),
        targetSessionId = params.optionalWireString("targetSessionId", "session.fork.params.targetSessionId"),
        title = params.optionalWireString("title", "session.fork.params.title"),
        lease = params["lease"]?.let { decodeSessionControlLeaseRef(it, "session.fork.params.lease") },
    )
}

@Serializable
data class SessionLeaseScopedParams(val sessionId: String, val lease: SessionControlLeaseRefParams? = null)

fun decodeSessionLeaseScopedParams(value: JsonElement, method: String): SessionLeaseScopedParams {
    val params = paramsObject(value, method)
    requireFields(params, setOf("sessionId", "lease"), "$method.params", "invalid_params")
    return SessionLeaseScopedParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        lease = params["lease"]?.let { decodeSessionControlLeaseRef(it, "$method.params.lease") },
    )
}

private fun decodeSessionControlLeaseRef(value: JsonElement, field: String): SessionControlLeaseRefParams {
    val lease = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "$field must be an object")
    requireFields(lease, setOf("scope", "generation"), field, "invalid_params")
    if (lease.requiredString("scope", "invalid_params") != "session-control") {
        throw AppServerProtocolException("invalid_params", "$field.scope must be session-control")
    }
    val generation = lease.requiredLong("generation", "invalid_params")
    if (generation < 1 || generation > MAX_SAFE_INTEGER) {
        throw AppServerProtocolException("invalid_params", "$field.generation must be a positive integer")
    }
    return SessionControlLeaseRefParams("session-control", generation)
}

@Serializable
data class SessionModelCallsParams(val sessionId: String, val includePayload: Boolean? = null)

fun decodeSessionModelCallsParams(value: JsonElement): SessionModelCallsParams {
    val params = paramsObject(value, "session.modelCalls")
    requireFields(params, setOf("sessionId", "includePayload"), "session.modelCalls.params", "invalid_params")
    val includePayload = params["includePayload"]?.let { element ->
        (element as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
            ?: throw AppServerProtocolException("invalid_params", "session.modelCalls.params.includePayload must be a boolean")
    }
    return SessionModelCallsParams(params.requiredString("sessionId", "invalid_params"), includePayload)
}

@Serializable
data class ComposerLeaseParams(val scope: String, val generation: Long)

@Serializable
data class SessionPlanParams(
    val sessionId: String,
    val commandId: String,
    val text: String,
    val context: List<String>? = null,
    val workspace: String? = null,
    val expectedRevision: Long? = null,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionPlanParams(value: JsonElement): SessionPlanParams {
    val params = paramsObject(value, "session.plan")
    // Retired permission keys are rejected explicitly so a caller cannot believe the removed field took effect.
    for (retiredKey in RETIRED_PERMISSION_PARAM_KEYS) {
        if (retiredKey in params) {
            throw AppServerProtocolException(
                "invalid_params",
                "session.plan.params.$retiredKey is a removed permission field; permissions are determined by the session permission mode",
            )
        }
    }
    requireFields(
        params,
        setOf("sessionId", "commandId", "text", "context", "workspace", "expectedRevision", "lease"),
        "session.plan.params",
        "invalid_params",
    )
    val context = params["context"]?.let { parseFreeformStringArray(it, "session.plan.params.context") }
    val expectedRevision = params["expectedRevision"]?.let {
        requireBoundedInteger(it, "session.plan.params.expectedRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
    }
    return SessionPlanParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        text = params.requiredString("text", "invalid_params"),
        context = context,
        workspace = params.optionalWireString("workspace", "session.plan.params.workspace"),
        expectedRevision = expectedRevision,
        lease = params["lease"]?.let { decodeSessionPlanLease(it, "session.plan.params.lease") },
    )
}

private fun decodeSessionPlanLease(value: JsonElement, field: String): ComposerLeaseParams {
    val lease = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "$field must be an object")
    requireFields(lease, setOf("scope", "generation"), field, "invalid_params")
    lease["scope"]?.let { scope ->
        if ((scope as? JsonPrimitive)?.takeIf { it.isString }?.content != "composer") {
            throw AppServerProtocolException("invalid_params", "$field.scope must be composer")
        }
    }
    val generation = lease.requiredLong("generation", "invalid_params")
    if (generation < 0) {
        throw AppServerProtocolException("invalid_params", "$field.generation must be a non-negative integer")
    }
    return ComposerLeaseParams("composer", generation)
}

private fun parseFreeformStringArray(value: JsonElement, field: String): List<String> {
    val array = value as? JsonArray
        ?: throw AppServerProtocolException("invalid_params", "$field must be a string array")
    return array.map { element ->
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw AppServerProtocolException("invalid_params", "$field must be a string array")
    }
}

@Serializable
data class FileReferenceParams(val workspaceId: String, val path: String)

@Serializable
data class SessionSubmitParams(
    val sessionId: String,
    val commandId: String,
    val text: String,
    val fileReferences: List<FileReferenceParams>? = null,
    val context: List<String>? = null,
    val maxTurns: Long? = null,
    val expectedRevision: Long? = null,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionSubmitParams(value: JsonElement): SessionSubmitParams {
    val params = paramsObject(value, "session.submit")
    requireFields(
        params,
        setOf("sessionId", "commandId", "text", "fileReferences", "context", "maxTurns", "expectedRevision", "lease"),
        "session.submit.params",
        "invalid_params",
    )
    val fileReferences = params["fileReferences"]?.let { element ->
        val array = element as? JsonArray
            ?: throw AppServerProtocolException("invalid_params", "session.submit.params.fileReferences must be a file reference array")
        array.map { reference ->
            val obj = reference as? JsonObject
                ?: throw AppServerProtocolException("invalid_params", "session.submit.params.fileReferences must be a file reference array")
            requireFields(obj, setOf("workspaceId", "path"), "session.submit.params.fileReferences", "invalid_params")
            FileReferenceParams(
                workspaceId = obj.requiredString("workspaceId", "invalid_params"),
                path = obj.requiredString("path", "invalid_params"),
            )
        }
    }
    return SessionSubmitParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        text = params.requiredPlainString("text", "session.submit.params.text"),
        fileReferences = fileReferences,
        context = params["context"]?.let { parseFreeformStringArray(it, "session.submit.params.context") },
        maxTurns = params["maxTurns"]?.let {
            requireBoundedInteger(it, "session.submit.params.maxTurns", 1, MAX_SAFE_INTEGER, "invalid_params")
        },
        expectedRevision = params["expectedRevision"]?.let {
            requireBoundedInteger(it, "session.submit.params.expectedRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.submit.params.lease") },
    )
}

private fun decodeComposerLeaseRef(value: JsonElement, field: String): ComposerLeaseParams {
    val lease = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "$field must be an object")
    requireFields(lease, setOf("scope", "generation"), field, "invalid_params")
    if (lease.requiredString("scope", "invalid_params") != "composer") {
        throw AppServerProtocolException("invalid_params", "$field.scope must be composer")
    }
    val generation = lease.requiredLong("generation", "invalid_params")
    if (generation < 1 || generation > MAX_SAFE_INTEGER) {
        throw AppServerProtocolException("invalid_params", "$field.generation must be a positive integer")
    }
    return ComposerLeaseParams("composer", generation)
}

@Serializable
data class SessionSteerParams(val sessionId: String, val runId: String, val commandId: String, val text: String)

fun decodeSessionSteerParams(value: JsonElement): SessionSteerParams {
    val params = paramsObject(value, "session.steer")
    requireFields(params, setOf("sessionId", "runId", "commandId", "text"), "session.steer.params", "invalid_params")
    return SessionSteerParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        runId = params.requiredString("runId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        text = params.requiredPlainString("text", "session.steer.params.text"),
    )
}

@Serializable
data class SessionCancelRunParams(val sessionId: String, val runId: String)

fun decodeSessionCancelRunParams(value: JsonElement): SessionCancelRunParams {
    val params = paramsObject(value, "session.cancelRun")
    requireFields(params, setOf("sessionId", "runId"), "session.cancelRun.params", "invalid_params")
    return SessionCancelRunParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        runId = params.requiredString("runId", "invalid_params"),
    )
}

@Serializable
data class SessionCancelInputParams(val sessionId: String, val inputId: String)

fun decodeSessionCancelInputParams(value: JsonElement): SessionCancelInputParams {
    val params = paramsObject(value, "session.cancelInput")
    requireFields(params, setOf("sessionId", "inputId"), "session.cancelInput.params", "invalid_params")
    return SessionCancelInputParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        inputId = params.requiredString("inputId", "invalid_params"),
    )
}

@Serializable
data class SessionMessagesParams(val sessionId: String, val before: String? = null, val limit: Long? = null)

fun decodeSessionMessagesParams(value: JsonElement): SessionMessagesParams {
    val params = paramsObject(value, "session.messages")
    requireFields(params, setOf("sessionId", "before", "limit"), "session.messages.params", "invalid_params")
    return SessionMessagesParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        before = params.optionalWireString("before", "session.messages.params.before"),
        limit = params["limit"]?.let {
            requireBoundedInteger(it, "session.messages.params.limit", 1, MAX_MESSAGES_LIMIT, "invalid_params")
        },
    )
}

@Serializable
data class AskUserSelectionParams(val questionId: String, val selectedOptionIds: List<String>)

@Serializable
data class AskUserFreeTextParams(val questionId: String, val text: String)

@Serializable
data class AskUserAnswerParams(
    val outcome: String,
    val answers: List<AskUserSelectionParams>? = null,
    val freeText: List<AskUserFreeTextParams>? = null,
)

@Serializable
data class SessionResolveInteractionParams(
    val sessionId: String,
    val resolutionId: String,
    val kind: String,
    val interactionId: String,
    val optionId: String? = null,
    val expectedPolicyRevision: Long? = null,
    val expectedScopeRevision: Long? = null,
    val answer: AskUserAnswerParams? = null,
)

fun decodeSessionResolveInteractionParams(value: JsonElement): SessionResolveInteractionParams {
    val params = paramsObject(value, "session.resolveInteraction")
    val kind = (params["kind"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return when (kind) {
        "tool_approval" -> decodeToolApprovalResolutionParams(params)
        "ask_user" -> decodeAskUserResolutionParams(params)
        else -> throw AppServerProtocolException(
            "invalid_params",
            "session.resolveInteraction.params.kind must be tool_approval or ask_user",
        )
    }
}

private fun decodeToolApprovalResolutionParams(params: JsonObject): SessionResolveInteractionParams {
    requireFields(
        params,
        setOf("sessionId", "resolutionId", "kind", "interactionId", "optionId", "expectedPolicyRevision", "expectedScopeRevision"),
        "session.resolveInteraction.params",
        "invalid_params",
    )
    return SessionResolveInteractionParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        resolutionId = params.requiredString("resolutionId", "invalid_params"),
        kind = "tool_approval",
        interactionId = params.requiredString("interactionId", "invalid_params"),
        optionId = params.requiredString("optionId", "invalid_params"),
        expectedPolicyRevision = params["expectedPolicyRevision"]?.let {
            requireBoundedInteger(it, "session.resolveInteraction.params.expectedPolicyRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        expectedScopeRevision = params["expectedScopeRevision"]?.let {
            requireBoundedInteger(it, "session.resolveInteraction.params.expectedScopeRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
    )
}

private fun decodeAskUserResolutionParams(params: JsonObject): SessionResolveInteractionParams {
    requireFields(
        params,
        setOf("sessionId", "resolutionId", "kind", "interactionId", "answer"),
        "session.resolveInteraction.params",
        "invalid_params",
    )
    return SessionResolveInteractionParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        resolutionId = params.requiredString("resolutionId", "invalid_params"),
        kind = "ask_user",
        interactionId = params.requiredString("interactionId", "invalid_params"),
        answer = decodeAskUserAnswer(params["answer"]),
    )
}

private fun decodeAskUserAnswer(value: JsonElement?): AskUserAnswerParams {
    val answer = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer must be an object")
    val outcome = (answer["outcome"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return when (outcome) {
        "answered" -> {
            requireFields(answer, setOf("outcome", "answers", "freeText"), "session.resolveInteraction.params.answer", "invalid_params")
            val answersElement = answer["answers"] as? JsonArray
                ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer.answers must be an array")
            AskUserAnswerParams(
                outcome = "answered",
                answers = answersElement.map(::decodeAskUserSelection),
                freeText = answer["freeText"]?.let(::decodeAskUserFreeTextList),
            )
        }
        "chat", "declined" -> {
            requireFields(answer, setOf("outcome"), "session.resolveInteraction.params.answer", "invalid_params")
            AskUserAnswerParams(outcome)
        }
        else -> throw AppServerProtocolException(
            "invalid_params",
            "session.resolveInteraction.params.answer.outcome must be answered, chat or declined",
        )
    }
}

private fun decodeAskUserSelection(value: JsonElement): AskUserSelectionParams {
    val selection = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer.answers must be an array of selections")
    requireFields(selection, setOf("questionId", "selectedOptionIds"), "session.resolveInteraction.params.answer.answers", "invalid_params")
    val optionIds = selection["selectedOptionIds"] as? JsonArray
        ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer.selectedOptionIds must be an array")
    return AskUserSelectionParams(
        questionId = selection.requiredString("questionId", "invalid_params"),
        selectedOptionIds = optionIds.map { optionId ->
            optionId as? JsonPrimitive ?: throw AppServerProtocolException(
                "invalid_params",
                "session.resolveInteraction.params.answer.selectedOptionIds must be an array of non-empty strings",
            )
            if (!optionId.isString || optionId.content.isBlank()) {
                throw AppServerProtocolException(
                    "invalid_params",
                    "session.resolveInteraction.params.answer.selectedOptionIds must be an array of non-empty strings",
                )
            }
            optionId.content
        },
    )
}

private fun decodeAskUserFreeTextList(value: JsonElement): List<AskUserFreeTextParams> {
    val array = value as? JsonArray
        ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer.freeText must be an array")
    return array.map { element ->
        val freeText = element as? JsonObject
            ?: throw AppServerProtocolException("invalid_params", "session.resolveInteraction.params.answer.freeText must be an array")
        requireFields(freeText, setOf("questionId", "text"), "session.resolveInteraction.params.answer.freeText", "invalid_params")
        AskUserFreeTextParams(
            questionId = freeText.requiredString("questionId", "invalid_params"),
            text = freeText.requiredPlainString("text", "session.resolveInteraction.params.answer.freeText.text"),
        )
    }
}

@Serializable
data class InteractionRequestParams(
    val sessionId: String,
    val scope: String,
    val leaseGeneration: Long? = null,
    val ttlMs: Long? = null,
)

fun decodeInteractionRequestParams(value: JsonElement, method: String): InteractionRequestParams {
    val params = paramsObject(value, method)
    requireFields(params, setOf("sessionId", "scope", "leaseGeneration", "ttlMs"), "$method.params", "invalid_params")
    val scope = (params["scope"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (scope != "composer" && scope != "session-control") {
        throw AppServerProtocolException("invalid_params", "$method.params.scope must be composer or session-control")
    }
    return InteractionRequestParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        scope = scope,
        leaseGeneration = params["leaseGeneration"]?.let {
            requireBoundedInteger(it, "$method.params.leaseGeneration", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        ttlMs = params["ttlMs"]?.let {
            requireBoundedInteger(it, "$method.params.ttlMs", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
    )
}

fun decodeInteractionLeaseScopedParams(value: JsonElement, method: String): InteractionRequestParams {
    val params = decodeInteractionRequestParams(value, method)
    if (params.leaseGeneration == null) {
        throw AppServerProtocolException("invalid_params", "$method.params.leaseGeneration is required")
    }
    return params
}

@Serializable
data class SessionSetPermissionModeParams(
    val sessionId: String,
    val mode: String,
    val expectedPolicyRevision: Long,
    val lease: SessionControlLeaseRefParams,
)

fun decodeSessionSetPermissionModeParams(value: JsonElement): SessionSetPermissionModeParams {
    val params = paramsObject(value, "session.setPermissionMode")
    requireFields(
        params,
        setOf("sessionId", "mode", "expectedPolicyRevision", "lease"),
        "session.setPermissionMode.params",
        "invalid_params",
    )
    val mode = params.requiredString("mode", "invalid_params")
    if (mode !in PERMISSION_MODES) {
        throw AppServerProtocolException("invalid_params", "session.setPermissionMode.params.mode is not a permission mode")
    }
    return SessionSetPermissionModeParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        mode = mode,
        expectedPolicyRevision = requireBoundedInteger(
            params["expectedPolicyRevision"]
                ?: throw AppServerProtocolException("invalid_params", "session.setPermissionMode.params.expectedPolicyRevision must be an integer"),
            "session.setPermissionMode.params.expectedPolicyRevision",
            0,
            MAX_SAFE_INTEGER,
            "invalid_params",
        ),
        lease = requiredSessionControlLease(params, "session.setPermissionMode"),
    )
}

@Serializable
data class PermissionRuleParams(val name: String, val behavior: String)

@Serializable
data class SessionSetPermissionRulesParams(
    val sessionId: String,
    val rules: List<PermissionRuleParams>,
    val expectedPolicyRevision: Long,
    val lease: SessionControlLeaseRefParams,
)

fun decodeSessionSetPermissionRulesParams(value: JsonElement): SessionSetPermissionRulesParams {
    val params = paramsObject(value, "session.setPermissionRules")
    requireFields(
        params,
        setOf("sessionId", "rules", "expectedPolicyRevision", "lease"),
        "session.setPermissionRules.params",
        "invalid_params",
    )
    val rulesElement = params["rules"] as? JsonArray
        ?: throw AppServerProtocolException("invalid_params", "session.setPermissionRules.params.rules must be an array")
    val rules = rulesElement.map { element ->
        val rule = element as? JsonObject
            ?: throw AppServerProtocolException("invalid_params", "session.setPermissionRules.params.rules must be an array of rules")
        requireFields(rule, setOf("name", "behavior"), "session.setPermissionRules.params.rules", "invalid_params")
        val behavior = rule.requiredString("behavior", "invalid_params")
        if (behavior !in PERMISSION_RULE_BEHAVIORS) {
            throw AppServerProtocolException("invalid_params", "session.setPermissionRules.params.rules.behavior must be allow, ask or deny")
        }
        PermissionRuleParams(name = rule.requiredString("name", "invalid_params"), behavior = behavior)
    }
    return SessionSetPermissionRulesParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        rules = rules,
        expectedPolicyRevision = requireBoundedInteger(
            params["expectedPolicyRevision"]
                ?: throw AppServerProtocolException("invalid_params", "session.setPermissionRules.params.expectedPolicyRevision must be an integer"),
            "session.setPermissionRules.params.expectedPolicyRevision",
            0,
            MAX_SAFE_INTEGER,
            "invalid_params",
        ),
        lease = requiredSessionControlLease(params, "session.setPermissionRules"),
    )
}

private fun requiredSessionControlLease(params: JsonObject, method: String): SessionControlLeaseRefParams =
    params["lease"]?.let { decodeSessionControlLeaseRef(it, "$method.params.lease") }
        ?: throw AppServerProtocolException("invalid_params", "$method.params.lease is required")

@Serializable
data class WorkspaceDiffParams(
    val sessionId: String,
    val cursor: String? = null,
    val limit: Long? = null,
    val includePatch: Boolean? = null,
)

fun decodeWorkspaceDiffParams(value: JsonElement): WorkspaceDiffParams {
    val params = paramsObject(value, "workspace.diff")
    requireFields(params, setOf("sessionId", "cursor", "limit", "includePatch"), "workspace.diff.params", "invalid_params")
    return WorkspaceDiffParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        cursor = params.optionalWireString("cursor", "workspace.diff.params.cursor"),
        limit = params["limit"]?.let {
            requireBoundedInteger(it, "workspace.diff.params.limit", 1, MAX_SAFE_INTEGER, "invalid_params")
        },
        includePatch = params.optionalBoolean("includePatch", "workspace.diff.params.includePatch"),
    )
}

@Serializable
data class WorkspaceReadFileParams(
    val sessionId: String,
    val path: String,
    val startLine: Long? = null,
    val maxLines: Long? = null,
    val expectedDigest: String? = null,
)

fun decodeWorkspaceReadFileParams(value: JsonElement): WorkspaceReadFileParams {
    val params = paramsObject(value, "workspace.readFile")
    requireFields(
        params,
        setOf("sessionId", "path", "startLine", "maxLines", "expectedDigest"),
        "workspace.readFile.params",
        "invalid_params",
    )
    val path = params.requiredString("path", "invalid_params")
    requireWorkspaceRelativeParamPath(path, "workspace.readFile.params.path")
    return WorkspaceReadFileParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        path = path,
        startLine = params["startLine"]?.let {
            requireBoundedInteger(it, "workspace.readFile.params.startLine", 1, MAX_SAFE_INTEGER, "invalid_params")
        },
        maxLines = params["maxLines"]?.let {
            requireBoundedInteger(it, "workspace.readFile.params.maxLines", 1, MAX_SAFE_INTEGER, "invalid_params")
        },
        expectedDigest = params.optionalWireString("expectedDigest", "workspace.readFile.params.expectedDigest"),
    )
}

private fun requireWorkspaceRelativeParamPath(path: String, field: String) {
    if (path.isBlank() || path.startsWith("/") || path.split("/").any { it == ".." }) {
        throw AppServerProtocolException("invalid_params", "$field must be a workspace-relative POSIX path")
    }
}

@Serializable
data class SessionCreateTaskParams(
    val sessionId: String,
    val commandId: String,
    val taskType: String,
    val title: String,
    val prompt: String,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionCreateTaskParams(value: JsonElement): SessionCreateTaskParams {
    val params = paramsObject(value, "session.createTask")
    requireFields(
        params,
        setOf("sessionId", "commandId", "taskType", "title", "prompt", "lease"),
        "session.createTask.params",
        "invalid_params",
    )
    val taskType = params.requiredPlainString("taskType", "session.createTask.params.taskType")
    if (taskType != "agent") {
        throw AppServerProtocolException(
            "invalid_params",
            "session.createTask.params.taskType must be agent; shell execution rides session.executeShell/executeUserShell",
        )
    }
    return SessionCreateTaskParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        taskType = taskType,
        title = params.requiredBoundedNonEmptyString("title", "session.createTask.params.title", MAX_TASK_TITLE_LENGTH),
        prompt = params.requiredBoundedNonEmptyString("prompt", "session.createTask.params.prompt", MAX_AGENT_PROMPT_LENGTH),
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.createTask.params.lease") },
    )
}

@Serializable
data class SessionCancelTaskParams(
    val sessionId: String,
    val taskId: String,
    val reason: String? = null,
)

fun decodeSessionCancelTaskParams(value: JsonElement): SessionCancelTaskParams {
    val params = paramsObject(value, "session.cancelTask")
    requireFields(params, setOf("sessionId", "taskId", "reason"), "session.cancelTask.params", "invalid_params")
    return SessionCancelTaskParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        taskId = params.requiredString("taskId", "invalid_params"),
        reason = params["reason"]?.let {
            params.requiredBoundedNonEmptyString("reason", "session.cancelTask.params.reason", MAX_CANCEL_TASK_REASON_LENGTH)
        },
    )
}

@Serializable
data class SessionGetTaskLogsParams(
    val sessionId: String,
    val taskId: String,
    val afterSequence: Long? = null,
    val limit: Long? = null,
)

fun decodeSessionGetTaskLogsParams(value: JsonElement): SessionGetTaskLogsParams {
    val params = paramsObject(value, "session.getTaskLogs")
    requireFields(
        params,
        setOf("sessionId", "taskId", "afterSequence", "limit"),
        "session.getTaskLogs.params",
        "invalid_params",
    )
    return SessionGetTaskLogsParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        taskId = params.requiredString("taskId", "invalid_params"),
        afterSequence = params["afterSequence"]?.let {
            requireBoundedInteger(it, "session.getTaskLogs.params.afterSequence", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        limit = params["limit"]?.let {
            requireBoundedInteger(it, "session.getTaskLogs.params.limit", 1, MAX_TASK_LOGS_LIMIT, "invalid_params")
        },
    )
}

@Serializable
data class SessionExecuteShellParams(
    val sessionId: String,
    val commandId: String,
    val argv: List<String>,
    val cwdRelative: String? = null,
    val timeoutMs: Long? = null,
)

fun decodeSessionExecuteShellParams(value: JsonElement): SessionExecuteShellParams {
    val params = paramsObject(value, "session.executeShell")
    requireFields(
        params,
        setOf("sessionId", "commandId", "argv", "cwdRelative", "timeoutMs"),
        "session.executeShell.params",
        "invalid_params",
    )
    val argv = params["argv"]
        ?: throw AppServerProtocolException("invalid_params", "session.executeShell.params.argv must be a string array")
    return SessionExecuteShellParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        argv = parseShellArgv(argv, "session.executeShell.params.argv"),
        cwdRelative = params.optionalShellCwdRelative("session.executeShell.params.cwdRelative"),
        timeoutMs = params.optionalShellTimeoutMs("session.executeShell.params.timeoutMs"),
    )
}

@Serializable
data class SessionExecuteUserShellParams(
    val sessionId: String,
    val commandId: String,
    val command: String,
    val cwdRelative: String? = null,
    val timeoutMs: Long? = null,
)

fun decodeSessionExecuteUserShellParams(value: JsonElement): SessionExecuteUserShellParams {
    val params = paramsObject(value, "session.executeUserShell")
    requireFields(
        params,
        setOf("sessionId", "commandId", "command", "cwdRelative", "timeoutMs"),
        "session.executeUserShell.params",
        "invalid_params",
    )
    return SessionExecuteUserShellParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        command = params.requiredBoundedNonEmptyString(
            "command",
            "session.executeUserShell.params.command",
            MAX_USER_SHELL_COMMAND_LENGTH,
        ),
        cwdRelative = params.optionalShellCwdRelative("session.executeUserShell.params.cwdRelative"),
        timeoutMs = params.optionalShellTimeoutMs("session.executeUserShell.params.timeoutMs"),
    )
}

private fun parseShellArgv(value: JsonElement, field: String): List<String> {
    val array = value as? JsonArray ?: throw AppServerProtocolException("invalid_params", "$field must be a string array")
    if (array.isEmpty() || array.size > MAX_SHELL_ARGV_ITEMS) {
        throw AppServerProtocolException("invalid_params", "$field must hold 1 to $MAX_SHELL_ARGV_ITEMS entries")
    }
    return array.map { element ->
        val argument = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: throw AppServerProtocolException("invalid_params", "$field must be a string array")
        if (argument.length > MAX_SHELL_ARG_LENGTH) {
            throw AppServerProtocolException("invalid_params", "$field entries must be at most $MAX_SHELL_ARG_LENGTH characters")
        }
        argument
    }
}

private fun JsonObject.optionalShellCwdRelative(field: String): String? {
    val path = optionalWireString("cwdRelative", field)
    path?.let { requireWorkspaceRelativeParamPath(it, field) }
    return path
}

private fun JsonObject.optionalShellTimeoutMs(field: String): Long? =
    this["timeoutMs"]?.let { requireBoundedInteger(it, field, 1, MAX_TASK_TIMEOUT_MS, "invalid_params") }

private fun JsonObject.requiredBoundedNonEmptyString(name: String, field: String, maxLength: Int): String {
    val value = requiredString(name, "invalid_params")
    if (value.length > maxLength) {
        throw AppServerProtocolException("invalid_params", "$field must be a non-empty string of at most $maxLength characters")
    }
    return value
}

@Serializable
data class SessionCompactParams(
    val sessionId: String,
    val commandId: String,
    val instructions: String? = null,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionCompactParams(value: JsonElement): SessionCompactParams {
    val params = paramsObject(value, "session.compact")
    requireFields(
        params,
        setOf("sessionId", "commandId", "instructions", "lease"),
        "session.compact.params",
        "invalid_params",
    )
    return SessionCompactParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        instructions = params["instructions"]?.let {
            params.requiredBoundedNonEmptyString("instructions", "session.compact.params.instructions", MAX_COMPACT_INSTRUCTIONS_LENGTH)
        },
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.compact.params.lease") },
    )
}

@Serializable
data class SessionAddDirectoryParams(
    val sessionId: String,
    val commandId: String,
    val directory: String,
    val workspaceRoot: String? = null,
    val expectedScopeRevision: Long? = null,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionAddDirectoryParams(value: JsonElement): SessionAddDirectoryParams {
    val params = paramsObject(value, "session.addDirectory")
    requireFields(
        params,
        setOf("sessionId", "commandId", "directory", "workspaceRoot", "expectedScopeRevision", "lease"),
        "session.addDirectory.params",
        "invalid_params",
    )
    return SessionAddDirectoryParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        directory = params.requiredString("directory", "invalid_params"),
        // Additional directories may live outside the workspace, so the wire takes host-side
        // absolute or workspace-relative paths verbatim; admission checks stay with the Host.
        workspaceRoot = params.optionalWireString("workspaceRoot", "session.addDirectory.params.workspaceRoot"),
        expectedScopeRevision = params["expectedScopeRevision"]?.let {
            requireBoundedInteger(it, "session.addDirectory.params.expectedScopeRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.addDirectory.params.lease") },
    )
}

@Serializable
data class SessionSetContextWindowParams(
    val sessionId: String,
    val commandId: String,
    val contextWindow: Long,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionSetContextWindowParams(value: JsonElement): SessionSetContextWindowParams {
    val params = paramsObject(value, "session.setContextWindow")
    requireFields(
        params,
        setOf("sessionId", "commandId", "contextWindow", "lease"),
        "session.setContextWindow.params",
        "invalid_params",
    )
    return SessionSetContextWindowParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        contextWindow = params["contextWindow"]
            ?.let { requireBoundedInteger(it, "session.setContextWindow.params.contextWindow", 1, MAX_SAFE_INTEGER, "invalid_params") }
            ?: throw AppServerProtocolException("invalid_params", "session.setContextWindow.params.contextWindow must be an integer"),
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.setContextWindow.params.lease") },
    )
}

@Serializable
data class SessionClearContextWindowParams(
    val sessionId: String,
    val commandId: String,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionClearContextWindowParams(value: JsonElement): SessionClearContextWindowParams {
    val params = paramsObject(value, "session.clearContextWindow")
    requireFields(params, setOf("sessionId", "commandId", "lease"), "session.clearContextWindow.params", "invalid_params")
    return SessionClearContextWindowParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.clearContextWindow.params.lease") },
    )
}

@Serializable
data class SessionSelectAgentParams(
    val sessionId: String,
    val commandId: String,
    val agentName: String? = null,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionSelectAgentParams(value: JsonElement): SessionSelectAgentParams {
    val params = paramsObject(value, "session.selectAgent")
    requireFields(
        params,
        setOf("sessionId", "commandId", "agentName", "lease"),
        "session.selectAgent.params",
        "invalid_params",
    )
    return SessionSelectAgentParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        agentName = params.optionalWireString("agentName", "session.selectAgent.params.agentName"),
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.selectAgent.params.lease") },
    )
}

@Serializable
data class SessionGoalUpdate(val action: String, val text: String? = null)

@Serializable
data class SessionUpdateGoalParams(
    val sessionId: String,
    val commandId: String,
    val update: SessionGoalUpdate,
    val lease: ComposerLeaseParams? = null,
)

fun decodeSessionUpdateGoalParams(value: JsonElement): SessionUpdateGoalParams {
    val params = paramsObject(value, "session.updateGoal")
    requireFields(params, setOf("sessionId", "commandId", "update", "lease"), "session.updateGoal.params", "invalid_params")
    return SessionUpdateGoalParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        update = decodeSessionGoalUpdate(
            params["update"] ?: throw AppServerProtocolException("invalid_params", "session.updateGoal.params.update must be an object"),
        ),
        lease = params["lease"]?.let { decodeComposerLeaseRef(it, "session.updateGoal.params.lease") },
    )
}

private fun decodeSessionGoalUpdate(value: JsonElement): SessionGoalUpdate {
    val update = value as? JsonObject ?: throw AppServerProtocolException("invalid_params", "session.updateGoal.params.update must be an object")
    requireFields(update, setOf("action", "text"), "session.updateGoal.params.update", "invalid_params")
    val action = update.requiredPlainString("action", "session.updateGoal.params.update.action")
    when (action) {
        "set" -> return SessionGoalUpdate(action, update.requiredString("text", "invalid_params"))
        "clear", "pause", "resume" -> {
            if ("text" in update) {
                throw AppServerProtocolException("invalid_params", "session.updateGoal.params.update.text is only valid with action set")
            }
            return SessionGoalUpdate(action)
        }
        else -> throw AppServerProtocolException("invalid_params", "session.updateGoal.params.update.action must be set, clear, pause or resume")
    }
}

@Serializable
data class SessionPreviewRewindParams(
    val sessionId: String,
    val checkpointId: String,
    val expectedRevision: Long? = null,
    val lease: SessionControlLeaseRefParams? = null,
)

fun decodeSessionPreviewRewindParams(value: JsonElement): SessionPreviewRewindParams {
    val params = paramsObject(value, "session.previewRewind")
    requireFields(
        params,
        setOf("sessionId", "checkpointId", "expectedRevision", "lease"),
        "session.previewRewind.params",
        "invalid_params",
    )
    return SessionPreviewRewindParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        checkpointId = params.requiredString("checkpointId", "invalid_params"),
        expectedRevision = params["expectedRevision"]?.let {
            requireBoundedInteger(it, "session.previewRewind.params.expectedRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        lease = params["lease"]?.let { decodeSessionControlLeaseRef(it, "session.previewRewind.params.lease") },
    )
}

@Serializable
data class SessionRewindParams(
    val sessionId: String,
    val commandId: String,
    val checkpointId: String,
    val expectedRevision: Long? = null,
    val lease: SessionControlLeaseRefParams? = null,
)

fun decodeSessionRewindParams(value: JsonElement): SessionRewindParams {
    val params = paramsObject(value, "session.rewind")
    requireFields(
        params,
        setOf("sessionId", "commandId", "checkpointId", "expectedRevision", "lease"),
        "session.rewind.params",
        "invalid_params",
    )
    return SessionRewindParams(
        sessionId = params.requiredString("sessionId", "invalid_params"),
        commandId = params.requiredString("commandId", "invalid_params"),
        checkpointId = params.requiredString("checkpointId", "invalid_params"),
        expectedRevision = params["expectedRevision"]?.let {
            requireBoundedInteger(it, "session.rewind.params.expectedRevision", 0, MAX_SAFE_INTEGER, "invalid_params")
        },
        lease = params["lease"]?.let { decodeSessionControlLeaseRef(it, "session.rewind.params.lease") },
    )
}

private fun paramsObject(value: JsonElement, method: String): JsonObject = value as? JsonObject
    ?: throw AppServerProtocolException("invalid_params", "$method params must be an object")

private fun JsonObject.optionalWireString(name: String, field: String): String? {
    val element = this[name] ?: return null
    val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (value.isNullOrBlank()) {
        throw AppServerProtocolException("invalid_params", "$field must be a non-blank string")
    }
    return value
}

private fun JsonObject.requiredPlainString(name: String, field: String): String =
    (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw AppServerProtocolException("invalid_params", "$field must be a string")

private fun JsonObject.optionalBoolean(name: String, field: String): Boolean? {
    val element = this[name] ?: return null
    return (element as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        ?: throw AppServerProtocolException("invalid_params", "$field must be a boolean")
}

private fun decodeScopeList(value: JsonElement, path: String): List<AppServerScope> = try {
    appServerJson.decodeFromJsonElement<List<AppServerScope>>(value)
} catch (error: IllegalArgumentException) {
    throw AppServerProtocolException("invalid_params", "$path contains an unknown scope")
}

private fun requireBoundedInteger(
    value: JsonElement,
    field: String,
    minimum: Long,
    maximum: Long,
    errorKind: String,
): Long {
    val parsed = (value as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        ?: throw AppServerProtocolException(errorKind, "$field must be an integer")
    if (parsed < minimum || parsed > maximum) {
        throw AppServerProtocolException(errorKind, "$field must be between $minimum and $maximum")
    }
    return parsed
}

private fun validatePairingToken(value: String, field: String) {
    if (!PAIRING_TOKEN_PATTERN.matches(value)) throw AppServerProtocolException("invalid_result", "$field has an invalid format")
}

private fun validateCredential(value: String, field: String) {
    if (!DEVICE_CREDENTIAL_PATTERN.matches(value)) throw AppServerProtocolException("invalid_result", "$field has an invalid format")
}

private fun validateHostId(value: String, field: String) {
    if (!isValidAppServerHostId(value)) throw AppServerProtocolException("invalid_result", "$field has an invalid format")
}

private val PAIRING_SCOPES = setOf(
    AppServerScope.SESSION_READ,
    AppServerScope.SESSION_WRITE,
    AppServerScope.APPROVAL_WRITE,
    AppServerScope.SHELL_EXECUTE,
    AppServerScope.SESSION_POLICY,
    AppServerScope.WORKSPACE_READ,
)

private fun validatePairingScopes(scopes: List<AppServerScope>, path: String) {
    if (scopes.isEmpty() || scopes.any { it !in PAIRING_SCOPES }) {
        throw AppServerProtocolException("invalid_result", "$path must contain only pairable scopes")
    }
}

fun decodeResyncRequiredNotification(value: JsonElement): AppServerResyncRequiredNotification {
    val notification = try {
        appServerJson.decodeFromJsonElement<AppServerResyncRequiredNotification>(value)
    } catch (error: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_params", "Invalid session.resyncRequired notification: ${error.message}")
    }
    if (notification.sessionId.isBlank() || notification.minimumRevision !in 1..MAX_SAFE_INTEGER) {
        throw AppServerProtocolException("invalid_params", "session.resyncRequired contains invalid required values")
    }
    return notification
}

fun encodeServerInitializeParams(params: ServerInitializeParams): JsonElement {
    validateServerInitializeParams(params)
    return appServerJson.encodeToJsonElement(ServerInitializeParams.serializer(), params)
}

fun encodeJsonRpcRequest(request: JsonRpcRequest): String = appServerJson.encodeToString(request)

fun encodeJsonRpcNotification(notification: JsonRpcNotification): String = appServerJson.encodeToString(notification)

fun jsonParams(block: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(block)

fun JsonObject.requiredString(name: String, errorKind: String = "invalid_result"): String {
    val primitive = this[name] as? JsonPrimitive
    val value = primitive?.takeIf { it.isString }?.content
    if (value.isNullOrBlank()) {
        throw AppServerProtocolException(errorKind, "Missing or invalid string field: $name")
    }
    return value
}

fun JsonObject.requiredLong(name: String, errorKind: String = "invalid_result"): Long {
    val primitive = this[name] as? JsonPrimitive
    val value = primitive?.takeIf { !it.isString }?.longOrNull
    if (value == null || value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) {
        throw AppServerProtocolException(errorKind, "Missing or invalid integer field: $name")
    }
    return value
}

private fun validateServerInitializeParams(params: ServerInitializeParams) {
    val errorKind = "invalid_params"
    if (params.appServerProtocolVersion != APP_SERVER_PROTOCOL_VERSION) {
        throw AppServerProtocolException("protocol_version_mismatch", "Unsupported App Server protocol version")
    }
    if (!isValidAppServerHostId(params.hostId)) {
        throw AppServerProtocolException(errorKind, "hostId has an invalid format")
    }
    requireWireString(params.client.clientId, "client.clientId", errorKind)
    requireWireString(params.client.name, "client.name", errorKind)
    requireWireString(params.client.version, "client.version", errorKind)
    params.client.capabilities?.forEachIndexed { index, capability ->
        requireWireString(capability, "client.capabilities[$index]", errorKind)
    }
    params.clientCapabilities?.let {
        validateAppServerCapabilities(it, "clientCapabilities", errorKind)
    }
    when (val auth = params.auth) {
        is DeviceServerInitializeAuth -> {
            val device = auth.device
            requireWireString(device.deviceId, "auth.device.deviceId", errorKind)
            requireWireString(device.credential, "auth.device.credential", errorKind)
            if (!DEVICE_CREDENTIAL_PATTERN.matches(device.credential)) {
                throw AppServerProtocolException(errorKind, "auth.device.credential has an invalid format")
            }
            if (!isValidDeviceChallenge(device.challenge)) {
                throw AppServerProtocolException(errorKind, "auth.device.challenge has an invalid format")
            }
            if (!isValidDeviceSignature(device.signature)) {
                throw AppServerProtocolException(errorKind, "auth.device.signature has an invalid format")
            }
        }
        is OperatorServerInitializeAuth -> requireWireString(auth.bearerToken, "auth.bearerToken", errorKind)
    }
    params.recovery?.let { recovery ->
        recovery.sessionId?.let { requireWireString(it, "recovery.sessionId", errorKind) }
        if (recovery.afterRevision != null && recovery.afterRevision !in 0..MAX_SAFE_INTEGER) {
            throw AppServerProtocolException(errorKind, "recovery.afterRevision must be a non-negative safe integer")
        }
    }
}

private fun validateServerInitializeResult(result: ServerInitializeResult) {
    val errorKind = "invalid_result"
    requireWireString(result.server.name, "server.name", errorKind)
    requireWireString(result.server.version, "server.version", errorKind)
    if (!isValidAppServerHostId(result.server.hostId)) {
        throw AppServerProtocolException(errorKind, "server.hostId has an invalid format")
    }
    requireWireString(result.connection.connectionId, "connection.connectionId", errorKind)
    result.connection.deviceId?.let { requireWireString(it, "connection.deviceId", errorKind) }
    validateAppServerCapabilities(result.capabilities, "capabilities", errorKind)
    result.host?.let { host ->
        host.workspaceRoot?.let { requireWireString(it, "host.workspaceRoot", errorKind) }
        host.configurationFingerprint?.let { requireWireString(it, "host.configurationFingerprint", errorKind) }
        host.workspaceFingerprint?.let { requireWireString(it, "host.workspaceFingerprint", errorKind) }
        host.securityFingerprint?.let { requireWireString(it, "host.securityFingerprint", errorKind) }
        host.workspaces?.forEachIndexed { index, workspace ->
            requireWireString(workspace.workspaceId, "host.workspaces[$index].workspaceId", errorKind)
            requireWireString(workspace.workspaceRoot, "host.workspaces[$index].workspaceRoot", errorKind)
        }
    }
}

private fun validateServerPreflightResult(result: ServerPreflightResult, raw: JsonObject) {
    val errorKind = "invalid_result"
    if (raw["deviceChallenge"] == JsonNull || raw["deviceChallengeExpiresAt"] == JsonNull) {
        throw AppServerProtocolException(errorKind, "server.preflight optional challenge fields must be omitted when absent")
    }
    if (!isValidAppServerHostId(result.hostId)) {
        throw AppServerProtocolException(errorKind, "server.preflight hostId has an invalid format")
    }
    if (!isValidAppServerHostProofNonce(result.nonce)) {
        throw AppServerProtocolException(errorKind, "server.preflight nonce has an invalid format")
    }
    if (result.expiresAt !in 0..MAX_SAFE_INTEGER) {
        throw AppServerProtocolException(errorKind, "server.preflight expiresAt must be a non-negative safe integer")
    }
    if (decodeAppServerHostPublicKey(result.hostPublicKey) == null) {
        throw AppServerProtocolException(errorKind, "server.preflight hostPublicKey has an invalid format")
    }
    if (decodeAppServerHostProofSignature(result.signature) == null) {
        throw AppServerProtocolException(errorKind, "server.preflight signature has an invalid format")
    }
    if (result.purpose == AppServerHostProofPurpose.DEVICE_CONNECT) {
        val challenge = result.deviceChallenge
        val challengeExpiresAt = result.deviceChallengeExpiresAt
        if (challenge == null || challengeExpiresAt == null || !isValidAppServerHostProofNonce(challenge)) {
            throw AppServerProtocolException(errorKind, "device-connect preflight requires a valid device challenge and expiry")
        }
        if (challengeExpiresAt !in 0..MAX_SAFE_INTEGER) {
            throw AppServerProtocolException(errorKind, "device-connect challenge expiry must be a non-negative safe integer")
        }
    } else if (result.deviceChallenge != null || result.deviceChallengeExpiresAt != null) {
        throw AppServerProtocolException(errorKind, "only device-connect preflight may include a device challenge")
    }
}

private fun requireWireString(value: String, field: String, errorKind: String) {
    if (value.isBlank()) throw AppServerProtocolException(errorKind, "$field must be a non-blank string")
}

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val PAIRING_TTL_MIN_MS = 30_000L
private const val PAIRING_TTL_MAX_MS = 600_000L
private const val MAX_INCLUDE_RECENT_MESSAGES = 100L
private const val MAX_REPLAY_LIMIT = 1_000L
private const val MAX_REPLAY_MAX_BYTES = 4_194_304L
private const val MAX_MESSAGES_LIMIT = 200L
private const val MAX_TASK_TITLE_LENGTH = 512
private const val MAX_AGENT_PROMPT_LENGTH = 32_768
private const val MAX_USER_SHELL_COMMAND_LENGTH = 65_536
private const val MAX_SHELL_ARGV_ITEMS = 64
private const val MAX_SHELL_ARG_LENGTH = 8_192
private const val MAX_TASK_TIMEOUT_MS = 86_400_000L
private const val MAX_CANCEL_TASK_REASON_LENGTH = 1_024
private const val MAX_TASK_LOGS_LIMIT = 500L
private const val MAX_COMPACT_INSTRUCTIONS_LENGTH = 4_096
private val RETIRED_PERMISSION_PARAM_KEYS = listOf("permissionProfile", "permissionProfiles")
private val PERMISSION_MODES = setOf("manual", "accept-edits", "plan", "full-access", "auto")
private val PERMISSION_RULE_BEHAVIORS = setOf("allow", "ask", "deny")
private val PAIRING_TOKEN_PATTERN = Regex("ag2cli-pairing\\.[A-Za-z0-9_-]{43}")
private val DEVICE_CREDENTIAL_PATTERN = Regex("ag2cli-device\\.[A-Za-z0-9_-]{43}")
