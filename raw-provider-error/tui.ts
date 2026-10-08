import { Plugin } from "@opencode/plugin/tui"

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `… [truncated ${text.length - max} chars]`
}

function safeJson(value: any, max = 2000): string {
  try {
    return truncate(JSON.stringify(value, null, 2) ?? String(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

// Formatos conhecidos:
// - V2 StructuredError: { type, message, status, response: { body } }
// - V1 ApiError: { name: "APIError", data: { message, statusCode, responseBody, metadata } }
// - retry status: { type: "retry", message, attempt, next, action }
function formatError(error: any): string {
  if (error == null) return "empty error payload"
  if (typeof error === "string") return error

  const lines: string[] = []

  if (typeof error.type === "string" && typeof error.message === "string" && "attempt" in error) {
    lines.push(`type: ${error.type}`)
    lines.push(`message: ${error.message}`)
    if (error.attempt != null) lines.push(`attempt: ${error.attempt}`)
    if ((error as any).next != null) lines.push(`next retry in: ${(error as any).next}ms`)
    const action = (error as any).action
    if (action) lines.push(`action: ${typeof action === "string" ? action : JSON.stringify(action)}`)
  }

  const name = error.name ?? error.type
  const message = error.message ?? error.data?.message
  const status = error.status ?? error.data?.statusCode ?? error.statusCode
  if (name) lines.push(`name/type: ${name}`)
  if (message) lines.push(`message: ${message}`)
  if (status != null) lines.push(`status: ${status}`)

  const rawBody: unknown =
    error.response?.body ?? error.data?.responseBody ?? error.data?.body ?? error.responseBody ?? error.body

  if (typeof rawBody === "string" && rawBody.length > 0) {
    let pretty = rawBody
    try {
      pretty = JSON.stringify(JSON.parse(rawBody), null, 2)
    } catch {
      // mantém o texto original se não for JSON
    }
    lines.push(`raw: ${pretty}`)
  }

  const metadata = error.metadata ?? error.data?.metadata
  if (metadata && typeof metadata === "object") {
    lines.push(`metadata: ${JSON.stringify(metadata)}`)
  }

  // Campos extras que costumam carregar o erro (cause, reason, classification...)
  for (const key of ["cause", "reason", "classification", "ref", "providerID"]) {
    const v = (error as any)?.[key] ?? (error as any)?.data?.[key]
    if (v != null && typeof v !== "object") lines.push(`${key}: ${v}`)
    else if (v != null) lines.push(`${key}: ${JSON.stringify(v)}`)
  }

  if (lines.length === 0) return safeJson(error)
  return lines.join("\n")
}

// Tenta achar um objeto-erro dentro de qualquer payload de evento.
function findErrorDeep(value: any, depth = 0): any | undefined {
  if (value == null || depth > 3) return undefined
  if (typeof value !== "object") return undefined
  if (typeof value.error === "object" && value.error !== null) return value.error
  if (typeof value.message === "string" && typeof value.type === "string" && "attempt" in value) return value
  // StructuredError / ApiError têm message + (status|type|name)
  if (typeof (value as any).message === "string" && ((value as any).status != null || (value as any).type || (value as any).name)) {
    return value
  }
  for (const key of ["info", "part", "message", "status", "data", "error"]) {
    const nested = (value as any)[key]
    if (nested && typeof nested === "object") {
      const found = findErrorDeep(nested, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

export default Plugin.define({
  id: "raw-provider-error",

  setup(context) {
    // Ring buffer dos últimos eventos — base para descobrir o formato real.
    const recent: Array<{ type: string; preview: string }> = []

    const showRaw = (source: string, error: any) => {
      try {
        context.ui.toast.show({
          title: `Raw provider error (${source})`,
          message: truncate(formatError(error)),
          variant: "error",
          duration: 30000,
        })
      } catch {
        try {
          context.ui.toast.show({
            title: `Raw provider error (${source})`,
            message: safeJson(error),
            variant: "error",
            duration: 30000,
          })
        } catch {
          // ignore
        }
      }
    }

    const record = (type: string, data: any) => {
      try {
        recent.push({ type, preview: safeJson(data, 800) })
        if (recent.length > 60) recent.shift()
      } catch {
        // ignore
      }
    }

    const ERROR_TYPES = new Set([
      "session.error",
      "session.execution.failed",
      "session.retry.scheduled",
      "session.step.failed",
      "session.tool.failed",
      "session.compaction.failed",
      "session.status",
      "message.updated",
      "message.part.updated",
    ])

    const handleEvent = (type: string, data: any) => {
      record(type, data)

      if (!ERROR_TYPES.has(type)) return

      if (type === "session.status") {
        const status = (data as any)?.status ?? data
        if (status?.type === "retry") {
          showRaw(type, status)
        } else {
          const err = findErrorDeep(data)
          if (err) showRaw(type, err)
        }
        return
      }

      const err = findErrorDeep(data) ?? data
      if (err && (typeof err === "object" || typeof err === "string")) {
        // message.updated sem erro é só ruído — ignora
        if ((type === "message.updated" || type === "message.part.updated") && !findErrorDeep(data)) return
        showRaw(type, err)
      }
    }

    const normalize = (envelope: any): { type: string; data: any } | undefined => {
      if (!envelope || typeof envelope !== "object") return undefined
      const details = (envelope as any).details ?? envelope
      const type = details?.type
      if (typeof type !== "string") return undefined
      const data = details?.data ?? (details as any)?.properties ?? (details as any)?.payload ?? details
      return { type, data }
    }

    const stopListen = context.data.listen((envelope: any) => {
      try {
        const parsed = normalize(envelope)
        if (parsed) handleEvent(parsed.type, parsed.data)
      } catch {
        // ignore
      }
    })

    // Inscrições específicas nos nomes de evento do TUI (não só do servidor).
    const stops: Array<() => void> = []
    for (const t of ERROR_TYPES) {
      try {
        stops.push(
          context.data.on(t as any, (event: any) => {
            try {
              const data = (event as any)?.data ?? (event as any)?.properties ?? event
              handleEvent(t, data)
            } catch {
              // ignore
            }
          }),
        )
      } catch {
        // tipo desconhecido nesta versão — o listen amplo já cobre
      }
    }

    context.keymap.layer(() => ({
      mode: "global" as any,
      priority: 10,
      commands: [
        {
          id: "raw-provider-error.test",
          title: "Raw provider error: show test toast",
          group: "Raw provider error",
          palette: true,
          slash: { name: "raw-error-test" },
          enabled: () => true,
          run: async () => {
            showRaw("test", {
              name: "APIError",
              data: {
                message: "Provider returned error (toast de teste do plugin raw-provider-error)",
                statusCode: 429,
                responseBody: JSON.stringify({
                  message: "Provider returned error",
                  code: 429,
                  metadata: {
                    provider_name: "Google AI Studio",
                    limit_source: "upstream_provider_shared_pool",
                  },
                }),
              },
            })
          },
        },
        {
          id: "raw-provider-error.dump",
          title: "Raw provider error: dump recent events",
          group: "Raw provider error",
          palette: true,
          slash: { name: "raw-error-dump" },
          enabled: () => true,
          run: async () => {
            const body =
              recent.length === 0
                ? "Nenhum evento capturado ainda. Reproduza o erro do provider e rode este comando de novo."
                : recent
                    .slice(-25)
                    .map((e) => `### ${e.type}\n${e.preview}`)
                    .join("\n\n")
            try {
              await context.ui.dialog.alert({ title: "Recent TUI events", message: truncate(body, 6000) })
            } catch {
              context.ui.toast.show({ title: "Recent TUI events", message: truncate(body), variant: "info", duration: 30000 })
            }
          },
        },
      ],
      bindings: [],
    }))

    context.ui.toast.show({
      title: "raw-provider-error",
      message: "loaded — listening for provider errors (/raw-error-test, /raw-error-dump)",
      variant: "success",
      duration: 5000,
    })

    return () => {
      try {
        stopListen()
      } catch {
        // ignore
      }
      for (const s of stops) {
        try {
          s()
        } catch {
          // ignore
        }
      }
    }
  },
})
