import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Aide de fusion de classes attendue par les composants shadcn/ui.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
