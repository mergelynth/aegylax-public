import type { ReactNode } from 'react'
import { AnimatePresence } from 'motion/react'
import { CreateLobbyModal } from '../lobby/CreateLobbyModal'
import { useUiStore } from '../../stores/uiStore'
import { Header } from './Header'
import styles from './AppShell.module.css'

/** The single persistent visual shell for both HOME and LOBBY states (spec §10). */
export function AppShell({ children }: { children: ReactNode }) {
  const isCreateLobbyModalOpen = useUiStore((state) => state.isCreateLobbyModalOpen)

  return (
    <div className={styles.shell}>
      <Header />
      <main className={styles.main}>{children}</main>
      <p className={styles.copyright} aria-hidden="true">
        © 2026 AEGYLAX. All rights reserved.
      </p>
      <AnimatePresence>{isCreateLobbyModalOpen ? <CreateLobbyModal /> : null}</AnimatePresence>
    </div>
  )
}
