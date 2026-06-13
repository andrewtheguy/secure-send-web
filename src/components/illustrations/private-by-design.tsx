/**
 * Original flat-style illustration authored for Secure Send (no external assets).
 * Free to use/modify — released by the project under its own license.
 * Colors are driven by theme tokens (fill-primary, fill-secondary, ...) so the
 * artwork tints to the palette and adapts to dark mode automatically. Offline-safe.
 *
 * Concept: your files, encrypted on your device — no server in the middle.
 * A shield/padlock guarding a folder, with a struck-through cloud/server to
 * emphasize the no-backend model. Distinct from the two-devices hero scene.
 */
interface IllustrationProps {
  className?: string;
}

export function PrivateByDesignIllustration({ className }: IllustrationProps) {
  return (
    <svg
      viewBox="0 0 360 280"
      className={className}
      role="img"
      aria-label="Files encrypted on your device behind a shield, with no server in the middle"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Soft background blobs */}
      <ellipse cx="180" cy="150" rx="166" ry="118" className="fill-primary/5" />
      <ellipse
        cx="180"
        cy="128"
        rx="96"
        ry="80"
        className="fill-secondary/10"
      />

      {/* Struck-through cloud (no server / no backend) — top left */}
      <g>
        <path
          d="M70 70 a20 20 0 0 1 38 -8 a16 16 0 0 1 22 15 a14 14 0 0 1 -3 27 H78 a18 18 0 0 1 -8 -34 Z"
          className="fill-muted"
        />
        <path
          d="M70 70 a20 20 0 0 1 38 -8 a16 16 0 0 1 22 15 a14 14 0 0 1 -3 27 H78 a18 18 0 0 1 -8 -34 Z"
          fill="none"
          strokeWidth="2.5"
          className="stroke-border"
        />
        {/* slash through it */}
        <path
          d="M64 96 L140 44"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-destructive/70"
        />
      </g>

      {/* Struck-through server stack — top right */}
      <g>
        <rect
          x="246"
          y="48"
          width="56"
          height="20"
          rx="5"
          className="fill-muted stroke-border"
          strokeWidth="2.5"
        />
        <rect
          x="246"
          y="74"
          width="56"
          height="20"
          rx="5"
          className="fill-muted stroke-border"
          strokeWidth="2.5"
        />
        <circle cx="258" cy="58" r="3" className="fill-muted-foreground/40" />
        <circle cx="258" cy="84" r="3" className="fill-muted-foreground/40" />
        <path
          d="M240 100 L308 42"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-destructive/70"
        />
      </g>

      {/* Central shield */}
      <g>
        <path
          d="M180 92 L240 116 V164 C240 206 214 234 180 248 C146 234 120 206 120 164 V116 Z"
          className="fill-primary"
        />
        <path
          d="M180 92 L240 116 V164 C240 206 214 234 180 248 C146 234 120 206 120 164 V116 Z"
          fill="none"
          strokeWidth="3"
          className="stroke-primary/40"
        />

        {/* Folder inside the shield */}
        <path
          d="M150 150 h16 l6 8 h26 a4 4 0 0 1 4 4 v28 a4 4 0 0 1 -4 4 h-48 a4 4 0 0 1 -4 -4 v-32 a4 4 0 0 1 4 -8 Z"
          className="fill-primary-foreground"
        />
        <rect
          x="158"
          y="172"
          width="44"
          height="6"
          rx="3"
          className="fill-primary/30"
        />
        <rect
          x="158"
          y="183"
          width="30"
          height="6"
          rx="3"
          className="fill-primary/20"
        />

        {/* Padlock badge at the shield tip */}
        <circle cx="180" cy="210" r="20" className="fill-secondary" />
        <path
          d="M172 204 v-5 a8 8 0 0 1 16 0 v5"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          className="stroke-secondary-foreground"
        />
        <rect
          x="170"
          y="204"
          width="20"
          height="16"
          rx="3.5"
          className="fill-secondary-foreground"
        />
        <circle cx="180" cy="211" r="2.5" className="fill-secondary" />
      </g>

      {/* Floating accents */}
      <circle cx="96" cy="150" r="5" className="fill-secondary/70" />
      <circle cx="270" cy="158" r="6" className="fill-accent/60" />
      <circle cx="130" cy="86" r="3.5" className="fill-primary/50" />
      <path
        d="M286 196 l5 5 m0 -5 l-5 5"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-accent/70"
      />
    </svg>
  );
}
