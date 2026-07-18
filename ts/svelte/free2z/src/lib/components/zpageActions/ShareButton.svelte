<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  } from '$lib/components/ui/dropdown-menu';
  import { Tooltip as TooltipPrimitive } from 'bits-ui';
  import { Content as TooltipContent } from '$lib/components/ui/tooltip';
  import { Share2Icon, Linkedin, CopyIcon } from '@lucide/svelte';
  import { page } from '$app/state';
  import { tStore as t } from '$lib/i18n';

  const props = $props();
  const { article = null, onOpen = () => {}, onClose = () => {} } = props;

  function getCanonical(): string {
    if (article?.get_url) {
      let url = article.get_url;
      if (!/^https?:\/\//.test(url)) {
        url = url.replace(/^\/zpage\//, '/');
        if (!/^https?:\/\//.test(url) && !url.startsWith('/')) {
          return '';
        }
        if (!/^https?:\/\//.test(url)) {
          url = `${page.url.origin}${url}`;
        }
      }
      // Validate the URL
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return '';
        }
      } catch (e) {
        return '';
      }
      return url;
    }
    return page.url.href;
  }

  function appendUTM(url: string, source: string) {
    try {
      const u = new URL(url);
      if (!u.searchParams.has('utm_source')) {
        u.searchParams.set('utm_source', source);
      }
      if (!u.searchParams.has('utm_medium')) {
        u.searchParams.set('utm_medium', 'social');
      }
      if (!u.searchParams.has('utm_campaign')) {
        u.searchParams.set('utm_campaign', 'share');
      }
      return u.toString();
    } catch (e) {
      const [base, query] = url.split('?');
      const params = new URLSearchParams(query || '');
      if (!params.has('utm_source')) {
        params.set('utm_source', source);
      }
      if (!params.has('utm_medium')) {
        params.set('utm_medium', 'social');
      }
      if (!params.has('utm_campaign')) {
        params.set('utm_campaign', 'share');
      }
      const queryString = params.toString();
      return queryString ? `${base}?${queryString}` : base;
    }
  }

  let open = $state(false);

  $effect(() => {
    if (open) {
      onOpen();
    } else {
      onClose();
    }
  });

  async function copyLink() {
    const url = getCanonical();
    if (!url) {
      toast.error($t('pageActions.share.linkUnavailable', 'Link unavailable'));
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success($t('pageActions.share.linkCopied', 'Link copied'));
    } catch (err) {
      toast.error($t('pageActions.share.copyFailed', 'Copy failed'));
    }
  }

  function openShare(url: string) {
    try {
      new URL(url);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast.error($t('pageActions.share.urlError', 'There was an error with the url'));
    }
  }

  function shareX() {
    const url = appendUTM(getCanonical(), 'x');
    const text = $t('pageActions.share.textX', `Check out ${article?.title || ''} by ${
      article?.creator?.username || 'Free2Z creator'
    } on Free2Z`, {
      title: article?.title || '',
      username: article?.creator?.username || 'Free2Z creator'
    });
    const shareUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(
      text
    )}&url=${encodeURIComponent(url)}`;
    openShare(shareUrl);
  }

  function shareReddit() {
    const url = appendUTM(getCanonical(), 'reddit');
    const shareUrl = `https://www.reddit.com/submit?url=${encodeURIComponent(
      url
    )}&title=${encodeURIComponent(article?.title || '')}`;
    openShare(shareUrl);
  }

  function shareLinkedIn() {
    const url = appendUTM(getCanonical(), 'linkedin');
    const shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
      url
    )}`;
    openShare(shareUrl);
  }

  function shareTelegram() {
    const url = appendUTM(getCanonical(), 'telegram');
    const text = $t('pageActions.share.textTelegram', `Check out ${article?.title || ''} by ${
      article?.creator?.username || ''
    } on Free2Z`, {
      title: article?.title || '',
      username: article?.creator?.username || ''
    });
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(
      url
    )}&text=${encodeURIComponent(text)}`;
    openShare(shareUrl);
  }
</script>

<div class="inline-block">
  <DropdownMenu bind:open>
    <TooltipPrimitive.Provider>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger>
          <DropdownMenuTrigger>
            <Button
              class="rounded-full"
              size="icon-lg"
              aria-label={$t('pageActions.share.label', 'Share this page')}
            >
              <Share2Icon class="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipPrimitive.Trigger>
        <TooltipContent side="left">{$t('pageActions.share.tooltip', 'Share')}</TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>

    <DropdownMenuContent class="w-56">
      <DropdownMenuItem onclick={copyLink}>
        <CopyIcon class="w-4 h-4 mr-2"/> 
        <span>{$t('pageActions.share.copyLink', 'Copy link')}</span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onclick={shareX}>
        <div class="flex items-center gap-2">
        <svg aria-hidden="true" role="img" class="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>
          <span>{$t('pageActions.share.x', 'Share on X')}</span>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem onclick={shareReddit}>
        <div class="flex items-center gap-2">
        <svg aria-hidden="true" role="img" class="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Reddit</title><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/></svg>
        <span>{$t('pageActions.share.reddit', 'Share on Reddit')}</span>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem onclick={shareLinkedIn}>
        <div class="flex items-center">
          <Linkedin class="w-4 h-4 mr-2" fill="currentColor" />
          <span>{$t('pageActions.share.linkedin', 'Share on LinkedIn')}</span>
        </div>
      </DropdownMenuItem>
      <DropdownMenuItem onclick={shareTelegram}>
        <div class="flex items-center gap-2" >
        <svg aria-hidden="true" role="img" class="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Telegram</title><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
        <span>{$t('pageActions.share.telegram', 'Share on Telegram')}</span>
        </div>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</div>