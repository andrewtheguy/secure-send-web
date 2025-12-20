interface LogoProps {
  className?: string
  folderColor?: string
  lockColor?: string
}

export function Logo({
  className = 'h-10 w-10',
  folderColor = '#6B7280',
  lockColor = '#374151'
}: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 180 180"
      className={className}
      aria-label="Secure Transfer Logo"
    >
      {/* Folder tab */}
      <path
        d="M20 45 L20 40 Q20 35 25 35 L70 35 L80 50 L155 50 Q160 50 160 55"
        fill={folderColor}
        opacity="0.6"
      />

      {/* Folder body */}
      <path
        d="M20 50 L20 140 Q20 145 25 145 L155 145 Q160 145 160 140 L160 55 Q160 55 155 50 L80 50 L70 35 L25 35 Q20 35 20 40 Z"
        fill={folderColor}
      />

      {/* Lock shackle (closed/locked) */}
      <path
        d="M75 102 L75 87 Q75 72 90 72 Q105 72 105 87 L105 102"
        fill="none"
        stroke={lockColor}
        strokeWidth="6"
        strokeLinecap="round"
      />

      {/* Lock body */}
      <rect
        x="70"
        y="102"
        width="40"
        height="30"
        rx="3"
        fill={lockColor}
      />

      {/* Keyhole */}
      <circle cx="90" cy="112" r="4" fill="white"/>
      <rect x="87" y="112" width="6" height="10" fill="white"/>
    </svg>
  )
}
