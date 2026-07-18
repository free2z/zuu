import Root from './carousel.svelte';
import Content from './carousel-content.svelte';
import Item from './carousel-item.svelte';
import Previous from './carousel-previous.svelte';
import Next from './carousel-next.svelte';

// Export as `any` to relax template typing temporarily.
export const RootAny = Root as unknown as any;
export const ContentAny = Content as unknown as any;
export const ItemAny = Item as unknown as any;
export const PreviousAny = Previous as unknown as any;
export const NextAny = Next as unknown as any;

export {
  RootAny as Root,
  ContentAny as Content,
  ItemAny as Item,
  PreviousAny as Previous,
  NextAny as Next,
  // aliases
  RootAny as Carousel,
  ContentAny as CarouselContent,
  ItemAny as CarouselItem,
  PreviousAny as CarouselPrevious,
  NextAny as CarouselNext,
};
