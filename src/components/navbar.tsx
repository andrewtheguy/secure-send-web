import { Link, NavLink } from 'react-router-dom'
import { ModeToggle } from '@/components/mode-toggle'

const linkBase =
  'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors'

export function Navbar() {
  return (
    <header className="w-full border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          Secure Send
        </Link>
        <nav className="flex items-center gap-2 text-sm">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            Send
          </NavLink>
          <NavLink
            to="/receive"
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            Receive
          </NavLink>
          <NavLink
            to="/about"
            className={({ isActive }) =>
              `${linkBase} ${isActive ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            About
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
    </header>
  )
}
