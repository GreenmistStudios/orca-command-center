import { MotionConfig } from 'motion/react'
import { Tooltip } from 'radix-ui'
import { useEffect } from 'react'
import { useGlobalHotkeys } from './hooks/useGlobalHotkeys'
import { CommandPalette } from './palette/CommandPalette'
import { Shell } from './shell/Shell'
import { useOcc } from './state/store'

let started = false

export function App() {
  useGlobalHotkeys()
  useEffect(() => {
    if (started) return
    started = true
    void useOcc.getState().init()
  }, [])
  return (
    <MotionConfig reducedMotion="user">
      <Tooltip.Provider delayDuration={300}>
        <CommandPalette />
        <Shell />
      </Tooltip.Provider>
    </MotionConfig>
  )
}
