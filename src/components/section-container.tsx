import { cn } from '@/lib/utils';

interface SectionContainerProps {
  children: React.ReactNode;
  className?: string;
}

/** Centered max-width wrapper used by the landing sections, aligned with the navbar/footer. */
export function SectionContainer({
  children,
  className,
}: SectionContainerProps) {
  return (
    <section className={cn('mx-auto w-full max-w-5xl px-6', className)}>
      {children}
    </section>
  );
}
