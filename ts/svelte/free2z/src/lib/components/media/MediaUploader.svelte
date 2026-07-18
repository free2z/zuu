<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onDestroy, createEventDispatcher } from 'svelte';
  import { fade, fly, slide, scale } from 'svelte/transition';
  import { ensureCSRFToken } from '$lib/api/config';
  import { toast } from "svelte-sonner";
  import {
    UploadCloud,
    File as FileIcon,
    X,
    Check,
    AlertCircle,
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';

  const dispatch = createEventDispatcher();

  type UploadStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error';

  type UploadItem = {
    id: string;
    file: File;
    previewUrl?: string;
    progress: number;
    status: UploadStatus;
    error?: string;
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '');
  const buildApiUrl = (path: string) => `${apiBase}${path}`;
  
  const formatBytes = (bytes?: number) => {
    if (!bytes || Number.isNaN(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  let dragActive = false;
  let uploadQueue: UploadItem[] = [];
  let isUploading = false;

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const newItems: UploadItem[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: file.type.startsWith('image') ? URL.createObjectURL(file) : undefined,
      progress: 0,
      status: 'queued',
    }));
    uploadQueue = [...uploadQueue, ...newItems];
    startUploads();
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragActive = false;
    if (event.dataTransfer?.files?.length) {
      addFiles(event.dataTransfer.files);
    }
  };

  const handleDrag = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'dragenter' || event.type === 'dragover') {
      dragActive = true;
    }
    if (event.type === 'dragleave') {
      dragActive = false;
    }
  };

  const setUploadState = (id: string, partial: Partial<UploadItem>) => {
    uploadQueue = uploadQueue.map((item) => (item.id === id ? { ...item, ...partial } : item));
  };

  const uploadSingle = async (item: UploadItem) =>
    new Promise<void>(async (resolve) => {
      setUploadState(item.id, { status: 'uploading', progress: 1, error: undefined });

      const formData = new FormData();
      formData.append('files', item.file);
      formData.append(
        'body',
        JSON.stringify([
          {
            title: item.file.name,
            name: item.file.name,
            access: 'private',
          },
        ])
      );

      const csrf = await ensureCSRFToken();
      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildApiUrl('/uploads/handle'), true);
      xhr.withCredentials = true;
      if (csrf) xhr.setRequestHeader('X-CSRFToken', csrf);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const pct = (event.loaded / event.total) * 100;
        setUploadState(item.id, {
          progress: Math.min(99, Math.floor(pct)),
          status: pct >= 100 ? 'processing' : 'uploading',
        });
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadState(item.id, { status: 'done', progress: 100 });
          toast.success(`${item.file.name} uploaded`);
          dispatch('upload-success');
        } else {
          setUploadState(item.id, {
            status: 'error',
            error: `Upload failed (${xhr.status})`,
            progress: 0,
          });
          toast.error(`${item.file.name} failed to upload`);
        }
        resolve();
      };

      xhr.onerror = () => {
        setUploadState(item.id, {
          status: 'error',
          error: 'Network error',
          progress: 0,
        });
        toast.error(`${item.file.name} failed to upload`);
        resolve();
      };

      xhr.send(formData);
    });

  const startUploads = async () => {
    if (isUploading) return;
    isUploading = true;
    for (const item of uploadQueue) {
      if (item.status === 'queued' || item.status === 'error') {
        await uploadSingle(item);
      }
    }
    isUploading = false;
  };

  const removeUpload = (id: string) => {
    uploadQueue = uploadQueue.filter((item) => item.id !== id);
  };

  onDestroy(() => {
    uploadQueue.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  });
</script>

<div class="space-y-4">
  <!-- Upload Area -->
  <div
    class={`relative group overflow-hidden rounded-xl border-2 border-dashed transition-all duration-300 ease-out
      ${dragActive 
        ? 'border-primary bg-primary/5 ring-4 ring-primary/10 scale-[1.01]' 
        : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30'
      }`}
    role="region"
    aria-label="Upload files by dragging or selecting"
    on:dragenter={handleDrag}
    on:dragover={handleDrag}
    on:dragleave={handleDrag}
    on:drop={handleDrop}
  >
    <div class="flex flex-col items-center justify-center gap-4 py-8 sm:py-12 text-center">
      <div class={`rounded-full bg-muted p-4 transition-transform duration-300 ${dragActive ? 'scale-110 bg-primary/10' : 'group-hover:scale-105'}`}>
        <UploadCloud class={`h-8 w-8 transition-colors ${dragActive ? 'text-primary' : 'text-muted-foreground'}`} />
      </div>
      <div class="space-y-1">
        <p class="text-lg font-medium">
          <span class="hidden sm:inline">Drag & drop files here or</span>
          <label class="cursor-pointer text-primary hover:underline hover:text-primary/80 transition-colors" for="file-input">
            browse
          </label>
        </p>
        <p class="text-sm text-muted-foreground">
          Supports images, videos, and audio files.
        </p>
      </div>
      <input
        id="file-input"
        type="file"
        multiple
        class="hidden"
        on:change={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          if (input.files) addFiles(input.files);
          input.value = ''; // Reset input
        }}
      />
    </div>
    
    {#if dragActive}
      <div 
        class="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[2px] transition-all"
        in:fade={{ duration: 200 }}
      >
        <div 
          class="rounded-full bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground shadow-lg"
          in:scale={{ start: 0.95, duration: 200 }}
        >
          Drop files to upload
        </div>
      </div>
    {/if}
  </div>

  <!-- Upload Queue -->
  {#if uploadQueue.length > 0}
    <div class="space-y-4" transition:slide={{ axis: 'y', duration: 300 }}>
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold tracking-tight uppercase text-muted-foreground">Active Uploads</h2>
        <span class="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full">
          {uploadQueue.filter(i => i.status === 'uploading' || i.status === 'queued').length} remaining
        </span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        {#each uploadQueue as item (item.id)}
          <div 
            class="group relative flex items-start gap-3 overflow-hidden rounded-lg border bg-card p-3 shadow-sm transition-all hover:shadow-md"
            in:fly={{ y: 10, duration: 300 }}
            out:fade={{ duration: 200 }}
          >
            <!-- Preview / Icon -->
            <div class="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border bg-muted">
              {#if item.previewUrl}
                <img src={item.previewUrl} alt={item.file.name} class="h-full w-full object-cover" />
              {:else}
                <div class="flex h-full w-full items-center justify-center text-muted-foreground">
                  <FileIcon class="h-6 w-6" />
                </div>
              {/if}
              {#if item.status === 'done'}
                <div class="absolute inset-0 flex items-center justify-center bg-green-500/20 backdrop-blur-[1px]">
                  <Check class="h-5 w-5 text-green-600 drop-shadow-sm" />
                </div>
              {:else if item.status === 'error'}
                <div class="absolute inset-0 flex items-center justify-center bg-destructive/20 backdrop-blur-[1px]">
                  <AlertCircle class="h-5 w-5 text-destructive drop-shadow-sm" />
                </div>
              {/if}
            </div>

            <!-- Content -->
            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
              <div class="flex items-start justify-between gap-2">
                <p class="truncate text-sm font-medium leading-none" title={item.file.name}>
                  {item.file.name}
                </p>
                <Button 
                  variant="ghost"
                  size="icon"
                  class="h-6 w-6 text-muted-foreground/50 hover:text-destructive transition-colors hover:bg-transparent"
                  onclick={() => removeUpload(item.id)}
                  aria-label="Remove upload"
                >
                  <X class="h-4 w-4" />
                </Button>
              </div>
              
              <div class="flex items-center justify-between text-xs text-muted-foreground">
                <span>{formatBytes(item.file.size)}</span>
                <span class:text-destructive={item.status === 'error'} class:text-green-600={item.status === 'done'}>
                  {#if item.status === 'uploading'}
                    {Math.round(item.progress)}%
                  {:else if item.status === 'processing'}
                    Processing...
                  {:else}
                    {item.status}
                  {/if}
                </span>
              </div>

              <!-- Progress Bar -->
              <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  class={`h-full transition-all duration-300 ease-out
                    ${item.status === 'error' ? 'bg-destructive' : 'bg-primary'}
                    ${item.status === 'done' ? 'bg-green-500' : ''}
                  `}
                  style={`width: ${Math.max(5, item.progress)}%`}
                >
                  {#if item.status === 'uploading' || item.status === 'processing'}
                    <div class="h-full w-full animate-progress-stripe bg-[linear-gradient(45deg,rgba(255,255,255,0.15)_25%,transparent_25%,transparent_50%,rgba(255,255,255,0.15)_50%,rgba(255,255,255,0.15)_75%,transparent_75%,transparent)] bg-[length:1rem_1rem]"></div>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

