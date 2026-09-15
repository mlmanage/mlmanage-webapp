"use client"

import type { Alert } from "@/lib/mlmanage-api"
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface AlertNotificationProps {
  alert: Alert
  onDismiss: (alertId: string) => void
}

function AlertIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "critical":
      return <AlertCircle className="size-4" />
    case "warning":
      return <AlertTriangle className="size-4" />
    case "info":
      return <Info className="size-4" />
    default:
      return <Info className="size-4" />
  }
}

function getSeverityStyles(severity: string) {
  switch (severity) {
    case "critical":
      return "border-red-600 bg-red-950 text-red-100"
    case "warning":
      return "border-amber-600 bg-amber-950 text-amber-100"
    case "info":
      return "border-blue-600 bg-blue-950 text-blue-100"
    default:
      return "border-zinc-600 bg-zinc-900 text-zinc-100"
  }
}

export function AlertNotification({
  alert,
  onDismiss,
}: AlertNotificationProps) {
  const severity = alert.severity || "info"

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border p-3 text-xs",
        getSeverityStyles(severity)
      )}
      role="alert"
    >
      <AlertIcon severity={severity} />
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm">{alert.alert_name}</p>
        <p className="mt-1">{alert.message}</p>
        {alert.gpu_uuid && (
          <p className="mt-1 opacity-75">GPU: {alert.gpu_uuid}</p>
        )}
        {alert.value !== undefined &&
          alert.threshold !== undefined &&
          alert.unit && (
            <p className="mt-1 opacity-75">
              Value: {alert.value} {alert.unit} (threshold: {alert.threshold}{" "}
              {alert.unit})
            </p>
          )}
      </div>
      <button
        onClick={() => onDismiss(alert.id)}
        className="ml-2 flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
        aria-label={`Dismiss alert: ${alert.alert_name}`}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

interface AlertStackProps {
  alerts: Alert[]
  onDismiss: (alertId: string) => void
  maxVisible?: number
}

export function AlertStack({
  alerts,
  onDismiss,
  maxVisible = 3,
}: AlertStackProps) {
  if (alerts.length === 0) return null

  const visibleAlerts = alerts.slice(0, maxVisible)
  const hiddenCount = alerts.length - maxVisible

  return (
    <div className="fixed right-4 top-16 z-50 flex flex-col gap-2 max-w-md">
      {visibleAlerts.map((alert) => (
        <AlertNotification
          key={alert.id}
          alert={alert}
          onDismiss={onDismiss}
        />
      ))}
      {hiddenCount > 0 && (
        <div className="text-xs text-zinc-400 px-3 py-2 text-center">
          +{hiddenCount} more alert{hiddenCount !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  )
}
