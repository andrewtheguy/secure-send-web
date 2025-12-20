import { Lock, Shield, Zap } from 'lucide-react'

export function Footer() {
  return (
    <footer className="w-full border-t bg-background/80 backdrop-blur mt-auto">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-center gap-6 px-6 py-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5 text-accent" />
          <span>End-to-end encrypted</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5 text-secondary" />
          <span>Direct P2P transfer</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-primary" />
          <span>No sign-up required</span>
        </div>
      </div>
    </footer>
  )
}
