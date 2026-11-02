const REDACTIONS: readonly [RegExp, string][] = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted:private-key]"],
	[/sk-[A-Za-z0-9_-]{20,}/g, "[redacted:api-key]"],
	[/Bearer [A-Za-z0-9._~+/-]{20,}=*/g, "[redacted:bearer]"],
	[/(password|passwd|secret|token)\s*[=:]\s*\S+/gi, "[redacted:credential]"],
	[/gh[pousr]_[A-Za-z0-9]{36,}/g, "[redacted:github-token]"],
	[/[A-Za-z0-9+/]{200,}={0,2}/g, "[binary]"],
];

/** Remove credentials and opaque binary payloads before indexing text. */
export function redact(text: string): string {
	let result = text;
	for (const [pattern, replacement] of REDACTIONS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
