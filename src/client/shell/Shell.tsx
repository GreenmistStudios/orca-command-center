import { motion } from 'motion/react'
import { AttentionStrip } from '../attention/AttentionStrip'
import { Rail } from '../rail/Rail'
import { useOcc } from '../state/store'
import { Banner } from './Banner'
import { CenterView } from './CenterView'
import { Dock } from './Dock'
import { Header } from './Header'
import { Splash } from './Splash'
import { ViewTabs } from './ViewTabs'

/**
 * Layout (design-system §8): field background, header, banner, then rail | center | dock.
 * The rail wrapper provides the 18rem width; below `lg` the columns stack (basic compact mode).
 * Shows the splash until the first bootstrap has been applied.
 */
export function Shell() {
  const ready = useOcc((s) => s.bootstrapped)
  if (!ready) return <Splash />
  return (
    <main className="relative isolate flex h-full flex-col gap-2 p-2" data-testid="shell">
      <div aria-hidden className="field-bg bg-field absolute inset-0 -z-10" />
      <Header />
      <Banner />
      <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col max-lg:overflow-y-auto">
        <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.9 }} className="flex w-full shrink-0 lg:w-72 max-lg:max-h-60">
          <Rail />
        </motion.div>
        <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col gap-2">
          <AttentionStrip />
          <ViewTabs />
          <CenterView />
        </div>
        <Dock />
      </div>
    </main>
  )
}
