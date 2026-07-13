'use client';

import * as ProgressPrimitive from '@radix-ui/react-progress';
import type * as React from 'react';

import { cn } from '@/lib/utils';

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      // translateZ(0) promotes the root to its own compositing layer so iOS
      // Safari keeps clipping the moving indicator to the rounded bounds
      // instead of intermittently letting it flash outside them.
      className={cn(
        'bg-primary/20 relative h-2 w-full overflow-hidden rounded-full [transform:translateZ(0)]',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        // Linear timing keeps repeated transition restarts from reading as a
        // pulsing stutter; transitioning only transform avoids animating
        // unrelated property changes.
        className="bg-primary h-full w-full flex-1 transition-transform duration-200 ease-linear will-change-transform"
        style={{
          transform: `translateX(-${100 - (value || 0)}%) translateZ(0)`,
        }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
