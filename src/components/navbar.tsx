import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Download, Info, Menu, Send, X } from 'lucide-react'
import { ModeToggle } from '@/components/mode-toggle'

const linkBase =
  'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors'

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false)

  const closeMobileMenu = () => {
    setMobileOpen(false)
  }

  return (
    <header className="w-full border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
        <Link to="/" className="inline-flex items-center gap-3">
          <img src="/logo.svg" alt="Secure Transfer" className="h-10 w-10" />
          <span className="font-semibold text-lg">Secure Transfer</span>
        </Link>
        <nav className="hidden items-center gap-2 text-sm md:flex">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            <Send className="h-4 w-4" />
            Send
          </NavLink>
          <NavLink
            to="/receive"
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            <Download className="h-4 w-4" />
            Receive
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            <Info className="h-4 w-4" />
            About
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-foreground shadow-sm transition-colors hover:bg-muted md:hidden"
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {mobileOpen && (
        <div className="border-t bg-background md:hidden">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-6 py-4 text-sm">
            <NavLink
              to="/"
              end
              onClick={closeMobileMenu}
              className={({ isActive }) =>
                `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
              }
            >
              <Send className="h-4 w-4" />
              Send
            </NavLink>
            <NavLink
              to="/receive"
              onClick={closeMobileMenu}
              className={({ isActive }) =>
                `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
              }
            >
              <Download className="h-4 w-4" />
              Receive
            </NavLink>
            <NavLink
              to="/about"
              onClick={closeMobileMenu}
              className={({ isActive }) =>
                `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
              }
            >
              <Info className="h-4 w-4" />
              About
            </NavLink>
          </div>
        </div>
      )}
    </header>
  )
}
