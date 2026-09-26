import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/utils';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn('flex items-stretch gap-0.5 overflow-x-auto border-b border-neutral-200 px-1', className)} {...props} />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        '-mb-px flex items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-2 py-2 text-xs font-medium text-neutral-500',
        'hover:text-neutral-900 focus-visible:outline-none data-[state=active]:border-neutral-900 data-[state=active]:text-neutral-900',
        '[&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  ),
);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Content ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto focus-visible:outline-none', className)} {...props} />
  ),
);
TabsContent.displayName = 'TabsContent';
