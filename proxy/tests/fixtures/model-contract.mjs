// The model fields from the proxy's GET /monitor, through the relay's session.codex, to the status line.
// The value after the export is plain JSON: the proxy test parses it, the relay and hook tests import it.
export default {
  "monitor": {
    "version": 1,
    "snapshot": {
      "sessions": [
        {
          "session_id": "sid-contract",
          "model": "opus → gpt-6-sol",
          "requested_model": "opus",
          "resolved_model": "gpt-6-sol"
        }
      ],
      "active": [
        {
          "request_id": "r-contract",
          "session_id": "sid-contract",
          "model": "opus → gpt-6-sol",
          "requested_model": "opus",
          "resolved_model": "gpt-6-sol"
        }
      ]
    }
  },
  "sessionId": "sid-contract",
  "codex": {
    "model": "opus → gpt-6-sol",
    "requestedModel": "opus",
    "resolvedModel": "gpt-6-sol"
  },
  "answeringModel": "gpt-6-sol"
}
