// The model fields from the proxy's GET /monitor, through the relay's session.codex, to the status line.
// `agents` is the same for subagents: their requests in /monitor, and the relay's session.agents.
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
  "answeringModel": "gpt-6-sol",
  "agents": {
    "monitor": {
      "version": 1,
      "snapshot": {
        "active": [
          {
            "request_id": "r-agent-live",
            "session_id": "sid-contract",
            "agent_id": "agent-contract",
            "requested_model": "gpt-5.6-terra",
            "resolved_model": "gpt-5.6-terra",
            "effort": "high"
          }
        ],
        "recent": [
          {
            "request_id": "r-agent-done",
            "session_id": "sid-contract",
            "agent_id": "agent-contract",
            "requested_model": "sonnet",
            "resolved_model": "gpt-5.4",
            "effort": "medium"
          }
        ]
      }
    },
    "sessionId": "sid-contract",
    "stats": {
      "agent-contract": {
        "requestedModel": "gpt-5.6-terra",
        "resolvedModel": "gpt-5.6-terra",
        "effort": "high",
        "requests": 2
      }
    }
  }
}
