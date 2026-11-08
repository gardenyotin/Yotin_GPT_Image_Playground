import { useEffect, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { activateFirstImportedProfile, buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { getServerManagedSettings, isDefaultConfigOnlyEnabled, mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import type { AppSettings } from './types'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import AgentWorkspace from './components/AgentWorkspace'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'
import SupportPromptModal from './components/SupportPromptModal'
import { FavoriteCollectionPickerModal, FavoriteCollectionsView, ManageCollectionsModal } from './components/FavoriteCollections'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import { getCompanyIdentity } from './lib/companyGallery'
import type { CompanyIdentity } from './lib/companyGallery'
import { useCompanyArchive } from './hooks/useCompanyArchive'
import CompanyGallery from './components/CompanyGallery'
import CompanyIdentityModal from './components/CompanyIdentityModal'

let customProviderConfigUrlImportStarted = false

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const [companyGallery, setCompanyGallery] = useState(window.location.hash === '#company-gallery')
  const [companyIdentity, setCompanyIdentity] = useState<CompanyIdentity | null>(getCompanyIdentity)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()
  useCompanyArchive(companyIdentity)

  useEffect(() => {
    const handleHashChange = () => setCompanyGallery(window.location.hash === '#company-gallery')
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  const showCompanyGallery = (visible: boolean) => {
    window.location.hash = visible ? 'company-gallery' : ''
    setCompanyGallery(visible)
  }

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const defaultConfigOnly = isDefaultConfigOnlyEnabled()

    const applyUrlSettings = (baseSettings: Partial<AppSettings>) => {
      if (defaultConfigOnly) return getServerManagedSettings(baseSettings)
      const nextSettings = buildSettingsFromUrlParams(baseSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : baseSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return

      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    if (customProviderConfigUrl && defaultConfigOnly && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          const state = useStore.getState()
          const baseSettings = importedSettings
            ? activateFirstImportedProfile(mergeImportedSettings(state.settings, importedSettings), importedSettings)
            : state.settings
          state.setSettings(applyUrlSettings(baseSettings))
          clearAppliedUrlSettings()
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
          const state = useStore.getState()
          state.setSettings(applyUrlSettings(state.settings))
          clearAppliedUrlSettings()
        })

      initStore()
      return
    }

    const nextSettings = applyUrlSettings(useStore.getState().settings)

    setSettings(nextSettings)

    clearAppliedUrlSettings()

    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    initStore()
  }, [setSettings])

  useEffect(() => {
    if (!isDefaultConfigOnlyEnabled()) return
    let cancelled = false
    void fetch('/api/runtime-config', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ model?: unknown; streamImages?: boolean; streamPartialImages?: number }>
      })
      .then((config) => {
        if (cancelled || typeof config.model !== 'string' || !config.model.trim()) return
        const state = useStore.getState()
        state.setSettings(getServerManagedSettings(state.settings, config.model, config.streamImages, config.streamPartialImages))
      })
      .catch((error) => console.warn('Failed to load server runtime config:', error))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      <Header companyGallery={companyGallery} onCompanyGalleryChange={showCompanyGallery} />
      {companyGallery && companyIdentity ? (
        <CompanyGallery identity={companyIdentity} onReuse={() => showCompanyGallery(false)} />
      ) : appMode === 'agent' ? (
        <AgentWorkspace />
      ) : (
        <main data-home-main data-drag-select-surface className="pb-48">
          <div className="safe-area-x max-w-7xl mx-auto">
            <SearchBar />
            {filterFavorite && !activeFavoriteCollectionId ? <FavoriteCollectionsView /> : <TaskGrid />}
          </div>
        </main>
      )}
      {!companyGallery && (
        <>
          <InputBar />
          <DetailModal />
          <Lightbox />
          <SettingsModal />
          <ConfirmDialog />
          <SupportPromptModal />
          <FavoriteCollectionPickerModal />
          <ManageCollectionsModal />
          <Toast />
          <MaskEditorModal />
          <ImageContextMenu />
        </>
      )}
      {!companyIdentity && <CompanyIdentityModal onResolved={setCompanyIdentity} />}
    </>
  )
}
