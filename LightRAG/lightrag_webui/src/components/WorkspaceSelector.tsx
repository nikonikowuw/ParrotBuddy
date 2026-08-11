import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getWorkspaces, type WorkspacesResponse } from '@/api/lightrag'
import { useSettingsStore } from '@/stores/settings'
import { LayersIcon } from 'lucide-react'

// Radix Select does not allow empty-string option values, so use a sentinel
// for the server's default workspace (which maps to "send no header").
const DEFAULT_SENTINEL = '__default__'

/**
 * Compact workspace selector for the site header.
 *
 * Fetches the list of workspaces the server can serve from ``/workspaces``.
 * Hidden entirely in single-workspace mode (or when only the default is
 * available) so existing deployments see no change. Selecting a workspace
 * stores it in the settings store; the axios request interceptor attaches
 * it as the ``LIGHTRAG-WORKSPACE`` header on every subsequent request.
 */
export default function WorkspaceSelector() {
  const { t } = useTranslation()
  const activeWorkspace = useSettingsStore.use.activeWorkspace()
  const setActiveWorkspace = useSettingsStore.use.setActiveWorkspace()
  const [data, setData] = useState<WorkspacesResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const resp = await getWorkspaces()
        if (!cancelled) setData(resp)
      } catch {
        // Server without the endpoint (older build) or unauthorized: hidden.
        if (!cancelled) setData(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Hide when not in multi-workspace mode, or when there is nothing to pick.
  if (!data || !data.multi_workspace) return null
  const options = data.workspaces
  if (options.length === 0) return null

  const currentValue = activeWorkspace ? activeWorkspace : DEFAULT_SENTINEL

  const handleChange = (value: string) => {
    setActiveWorkspace(value === DEFAULT_SENTINEL ? '' : value)
  }

  return (
    <Select value={currentValue} onValueChange={handleChange}>
      <SelectTrigger
        className="h-8 w-[140px] gap-1 px-2 text-xs"
        aria-label={t('header.workspace', 'Workspace')}
        title={t('header.workspace', 'Workspace')}
      >
        <LayersIcon className="size-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
        <SelectValue placeholder={t('header.workspace', 'Workspace')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_SENTINEL}>
          {data.default ? `${data.default} (${t('header.default', 'default')})` : t('header.default', 'Default')}
        </SelectItem>
        {options
          .filter((ws) => ws !== data.default)
          .map((ws) => (
            <SelectItem key={ws} value={ws}>
              {ws}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}
