interface LogoProps {
  className?: string
}

export function Logo({ className = 'h-10 w-10' }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-label="Secure Send Logo"
    >
      {/* Folder - #6B7280 in light, currentColor in dark */}
      <path
        className="fill-[#6B7280] dark:fill-current dark:opacity-60"
        d="M4 4C2.89543 4 2 4.89543 2 6V18C2 19.1046 2.89543 20 4 20H20C21.1046 20 22 19.1046 22 18V8C22 6.89543 21.1046 6 20 6H12.4142C12.149 6 11.8946 5.89464 11.7071 5.70711L10.5858 4.58579C10.2107 4.21071 9.70201 4 9.17157 4H4Z"
      />
      {/* Lock shackle - #374151 in light, currentColor in dark */}
      <path
        className="stroke-[#374151] dark:stroke-current"
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M9 13V11.5C9 9.84315 10.3431 8.5 12 8.5C13.6569 8.5 15 9.84315 15 11.5V13"
      />
      {/* Lock body - #374151 in light, currentColor in dark */}
      <rect
        className="fill-[#374151] dark:fill-current"
        x="8.5"
        y="13"
        width="7"
        height="4.5"
        rx="1"
      />
    </svg>
  )
}
