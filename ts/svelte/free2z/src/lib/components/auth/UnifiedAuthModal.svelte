<script context="module" lang="ts">
  const RECAPTCHA_LOAD_TIMEOUT_MS = 15_000;
  let recaptchaScriptPromise: Promise<void> | null = null;
  let recaptchaContainerSequence = 0;
</script>

<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { z } from 'zod';
  import { authStore } from '$lib/stores/auth';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Eye, EyeOff, Loader2 } from '@lucide/svelte';
  import { dev, browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
  import * as Dialog from "$lib/components/ui/dialog";
  import { MediaQuery } from "svelte/reactivity";
  import * as Drawer from "$lib/components/ui/drawer";

  // https://developers.google.com/recaptcha/docs/faq#id-like-to-run-automated-tests-with-recaptcha.-what-should-i-do
  const RECAPTCHA_TEST_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
  const RECAPTCHA_PRODUCTION_SITE_KEY = '6LckfE8pAAAAAO6LqS7OOYiuDjaL84H3tSKmHxJ4';
  const RECAPTCHA_SITE_KEY =
    env.PUBLIC_RECAPTCHA_SITE_KEY ||
    (dev ? RECAPTCHA_TEST_SITE_KEY : RECAPTCHA_PRODUCTION_SITE_KEY);
  const isDesktop = new MediaQuery("(min-width: 768px)");
  const passwordStrengthColors = ['', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-emerald-500'];

  let recaptchaWidgetId: number | null = null;
  let recaptchaResolve: ((token: string) => void) | null = null;
  let recaptchaReject: ((error: Error) => void) | null = null;
  let recaptchaTimeout: ReturnType<typeof setTimeout> | null = null;
  let isRecaptchaPending = false;
  let recaptchaInitializationPromise: Promise<void> | null = null;
  const recaptchaContainerId = `recaptcha-container-${++recaptchaContainerSequence}`;

  function clearRecaptchaAttempt() {
    if (recaptchaTimeout !== null) {
      clearTimeout(recaptchaTimeout);
      recaptchaTimeout = null;
    }
    recaptchaResolve = null;
    recaptchaReject = null;
    isRecaptchaPending = false;
  }

  function resolveRecaptcha(token: string) {
    const resolve = recaptchaResolve;
    clearRecaptchaAttempt();
    resolve?.(token);
  }

  function resetRecaptchaWidget() {
    if (recaptchaWidgetId === null || !(window as any).grecaptcha?.reset) return;
    try {
      (window as any).grecaptcha.reset(recaptchaWidgetId);
    } catch {
      // The widget may already have been removed during navigation.
    }
  }

  function rejectRecaptcha(message: string) {
    const reject = recaptchaReject;
    resetRecaptchaWidget();
    clearRecaptchaAttempt();
    reject?.(new Error(message));
  }

  function loadRecaptchaScript(): Promise<void> {
    if ((window as any).grecaptcha?.render) return Promise.resolve();
    if (recaptchaScriptPromise) return recaptchaScriptPromise;

    recaptchaScriptPromise = new Promise<void>((resolve, reject) => {
      let pollTimeout: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      let script: HTMLScriptElement;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (pollTimeout !== null) clearTimeout(pollTimeout);
        script.removeEventListener('error', handleError);
        if (error) script.remove();
        if ((window as any).onRecaptchaLoaded === checkReady) {
          delete (window as any).onRecaptchaLoaded;
        }
        error ? reject(error) : resolve();
      };

      const deadline = Date.now() + RECAPTCHA_LOAD_TIMEOUT_MS;
      const checkReady = () => {
        if ((window as any).grecaptcha?.render) {
          finish();
        } else if (Date.now() >= deadline) {
          finish(new Error('Timed out loading reCAPTCHA'));
        } else {
          pollTimeout = setTimeout(checkReady, 50);
        }
      };

      const handleError = () => finish(new Error('Failed to load reCAPTCHA script'));
      const existingScript = document.querySelector<HTMLScriptElement>('script[src*="recaptcha/api.js"]');
      if (existingScript) {
        script = existingScript;
      } else {
        script = document.createElement('script');
        script.src = 'https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoaded&render=explicit';
        script.async = true;
        script.defer = true;
      }

      script.addEventListener('error', handleError, { once: true });
      (window as any).onRecaptchaLoaded = checkReady;
      if (!existingScript) document.head.appendChild(script);
      checkReady();
    }).catch((error) => {
      recaptchaScriptPromise = null;
      throw error;
    });

    return recaptchaScriptPromise;
  }

  async function ensureRecaptchaWidget() {
    if (!browser || dev) return;
    if (recaptchaWidgetId !== null) return;
    if (recaptchaInitializationPromise) return recaptchaInitializationPromise;

    recaptchaInitializationPromise = (async () => {
      await loadRecaptchaScript();

      if (recaptchaWidgetId === null) {
        let container = document.getElementById(recaptchaContainerId);
        if (!container) {
          container = document.createElement('div');
          container.id = recaptchaContainerId;
          document.body.appendChild(container);
        }
        recaptchaWidgetId = (window as any).grecaptcha.render(container, {
          sitekey: RECAPTCHA_SITE_KEY,
          size: 'invisible',
          theme: 'dark',
          callback: (token: string) => {
            resolveRecaptcha(token);
          },
          'error-callback': () => {
            console.error('[reCAPTCHA] widget error — network or config issue');
            rejectRecaptcha('reCAPTCHA encountered an error');
          },
          'expired-callback': () => {
            console.warn('[reCAPTCHA] token expired before submission');
            rejectRecaptcha('reCAPTCHA token expired');
          },
        });
      }
    })();

    try {
      await recaptchaInitializationPromise;
    } catch (error) {
      recaptchaInitializationPromise = null;
      document.getElementById(recaptchaContainerId)?.remove();
      throw error;
    }
  }

  async function executeRecaptcha(): Promise<string> {
    if (dev) return 'test';

    try {
      await ensureRecaptchaWidget();
    } catch {
      throw new Error('Failed to load reCAPTCHA');
    }

    if (recaptchaWidgetId === null) {
      throw new Error('reCAPTCHA widget not available');
    }

    if (isRecaptchaPending) {
      throw new Error('reCAPTCHA verification already in progress');
    }

    return new Promise((resolve, reject) => {
      isRecaptchaPending = true;
      recaptchaResolve = resolve;
      recaptchaReject = reject;
      recaptchaTimeout = setTimeout(() => {
        rejectRecaptcha('reCAPTCHA timeout');
      }, 60000);

      try {
        (window as any).grecaptcha.reset(recaptchaWidgetId);
        (window as any).grecaptcha.execute(recaptchaWidgetId);
      } catch {
        rejectRecaptcha('Failed to execute reCAPTCHA');
      }
    });
  }

  // Initialize only the modal that is actually opened. Pages may render several
  // auth entry points, and sharing one global widget makes ownership nondeterministic.
  $: if (open && browser && !dev && recaptchaWidgetId === null) {
    ensureRecaptchaWidget().catch(console.error);
  }

  onDestroy(() => {
    if (!browser) return;
    if (isRecaptchaPending) rejectRecaptcha('reCAPTCHA cancelled');
    else clearRecaptchaAttempt();
    resetRecaptchaWidget();
    document.getElementById(recaptchaContainerId)?.remove();
    recaptchaWidgetId = null;
    recaptchaInitializationPromise = null;
  });

  // Modal view states
  type ModalView = 'login' | 'signup' | 'resetPassword' | 'checkEmail';

  // Props
  export let open = false;

  // Event dispatcher
  const dispatch = createEventDispatcher<{
    close: void;
    success: { creator: any };
    requiresOTP: { username: string; password: string };
  }>();

  // Current view state
  let currentView: ModalView = 'login';

  // Form state
  let username = '';
  let password = '';
  let confirmPassword = '';
  let email = '';
  let resetEmail = '';
  let showPassword = false;
  let showConfirmPassword = false;
  let errors: Record<string, string> = {};
  let isLoading = false;
  let recaptchaToken = '';

  // Email verification state
  let pendingEmail = '';

  // Reactive validation schemas that use current translations
  $: loginSchema = z.object({
    username: z.string().min(1, t('auth.errors.usernameRequired')).max(128, t('auth.errors.usernameTooLong')),
    password: z.string().min(8, t('auth.errors.passwordMinLength')),
  });

  $: signupSchema = z.object({
    username: z.string().min(1, t('auth.errors.usernameRequired')).max(128, t('auth.errors.usernameTooLong')),
    password: z.string().min(8, t('auth.errors.passwordMinLength')),
    confirmPassword: z.string().min(8, t('auth.errors.confirmPassword')),
    email: z.string().email(t('auth.errors.invalidEmail')).optional().or(z.literal('')),
  }).refine((data) => data.password === data.confirmPassword, {
    message: t('auth.errors.passwordsNotMatch'),
    path: ['confirmPassword'],
  });

  $: resetPasswordSchema = z.object({
    email: z.string().email(t('auth.errors.validEmailRequired')),
  });

  // Keep submitted values alive until the in-flight auth attempt settles.
  $: if (!open && !isLoading && !isRecaptchaPending) {
    resetForm();
  }

  function resetForm() {
    username = '';
    password = '';
    confirmPassword = '';
    email = '';
    resetEmail = '';
    pendingEmail = '';
    errors = {};
    showPassword = false;
    showConfirmPassword = false;
    isLoading = false;
    currentView = 'login';
    if (!dev) {
      recaptchaToken = '';
    }
  }

  // Reapply dev token if needed (for both login and signup)
  $: if (open && dev && !recaptchaToken) {
    recaptchaToken = 'test';
  }

  // Handle form submission based on current view
  async function handleSubmit() {
    if (isLoading || isRecaptchaPending) return;

    if (currentView === 'login') {
      await handleLogin();
    } else if (currentView === 'signup') {
      await handleSignup();
    } else if (currentView === 'resetPassword') {
      await handlePasswordReset();
    } else if (currentView === 'checkEmail') {
      await handleEmailConfirmed();
    }
  }

  async function handleLogin() {
    try {
      const result = loginSchema.safeParse({ username, password });
      if (!result.success) {
        errors = {};
        result.error.errors.forEach((error) => {
          errors[error.path[0]] = error.message;
        });
        return;
      }

      errors = {};
      isLoading = true;
      const submittedUsername = result.data.username;
      const submittedPassword = result.data.password;

      // Get reCAPTCHA token
      try {
        recaptchaToken = await executeRecaptcha();
      } catch (e: any) {
        errors.general = 'reCAPTCHA verification failed. Please try again.';
        isLoading = false;
        return;
      }

      // Use loginOnly method for pure login (no signup attempt)
      const authResult = await authStore.loginOnly(submittedUsername, submittedPassword, recaptchaToken);

      if (authResult.success) {
        dispatch('success', { creator: authResult.creator });
        close();
      } else if ((authResult as any).requiresOTP) {
        dispatch('requiresOTP', { username: submittedUsername, password: submittedPassword });
        close();
      } else {
        errors.general = authResult.error || 'Login failed';
      }
    } catch (error: any) {
      console.error('Login error:', error);
      errors.general = error.message || 'Login failed';
    } finally {
      isLoading = false;
    }
  }

  async function handleSignup() {
    try {
      const result = signupSchema.safeParse({ username, password, confirmPassword, email });
      if (!result.success) {
        errors = {};
        result.error.errors.forEach((error) => {
          errors[error.path[0]] = error.message;
        });
        return;
      }

      errors = {};
      isLoading = true;
      const submittedUsername = result.data.username;
      const submittedPassword = result.data.password;
      const submittedEmail = result.data.email ?? '';

      // Get reCAPTCHA token
      try {
        recaptchaToken = await executeRecaptcha();
      } catch (e: any) {
        errors.general = 'reCAPTCHA verification failed. Please try again.';
        isLoading = false;
        return;
      }

      const authResult = await authStore.signup(submittedUsername, submittedPassword, recaptchaToken);

      if (authResult.success) {
        // If email was provided, send verification and show email verification view
        if (submittedEmail.trim()) {
          // Send email verification (don't block on this)
          authStore.sendEmailVerification(submittedEmail).catch(console.error);
          pendingEmail = submittedEmail;
          currentView = 'checkEmail';
          isLoading = false;
        } else {
          // No email provided, just log them in
          const loginResult = await authStore.loginOnly(submittedUsername, submittedPassword, recaptchaToken);
          if (loginResult.success) {
            dispatch('success', { creator: loginResult.creator });
            close();
          } else {
            errors.general = loginResult.error || 'Account created but login failed';
          }
        }
      } else {
        // If user exists, fall back to login
        if (authResult.error?.toLowerCase().includes('exists')) {
          const loginResult = await authStore.loginOnly(submittedUsername, submittedPassword, recaptchaToken);
          if (loginResult.success) {
            dispatch('success', { creator: loginResult.creator });
            close();
          } else if ((loginResult as any).requiresOTP) {
            dispatch('requiresOTP', { username: submittedUsername, password: submittedPassword });
            close();
          } else {
            errors.general = loginResult.error || 'Login failed';
          }
        } else {
          errors.general = authResult.error || 'Signup failed';
        }
      }
    } catch (error: any) {
      console.error('Signup error:', error);
      errors.general = error.message || 'Signup failed';
    } finally {
      isLoading = false;
    }
  }

  async function handlePasswordReset() {
    try {
      const result = resetPasswordSchema.safeParse({ email: resetEmail });
      if (!result.success) {
        errors = {};
        result.error.errors.forEach((error) => {
          errors[error.path[0]] = error.message;
        });
        return;
      }

      errors = {};
      isLoading = true;

      const resetResult = await authStore.resetPassword(resetEmail);

      if (resetResult.success) {
        // Transition to check email view
        pendingEmail = resetEmail;
        currentView = 'checkEmail';
      } else {
        errors.general = resetResult.error || 'Password reset failed';
      }
    } catch (error: any) {
      console.error('Password reset error:', error);
      errors.general = error.message || 'Password reset failed';
    } finally {
      isLoading = false;
    }
  }

  async function handleEmailConfirmed() {
    isLoading = true;
    // Log them in directly regardless of verification status
    const loginResult = await authStore.loginOnly(username, password);

    if (loginResult.success) {
      dispatch('success', { creator: loginResult.creator });
      close();
    } else {
      errors.general = loginResult.error || 'Login failed';
      isLoading = false;
    }
  }

  async function handleTwitterLogin() {
    try {
      isLoading = true;

      // Call the Twitter OAuth start endpoint
      const response = await fetch('/api/twitter/start', {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to start Twitter login');
      }

      const data = await response.json();
      const { state, code_challenge } = data;

      // Get Twitter client ID from environment variables
      const TWITTER_CLIENT_ID = import.meta.env.VITE_TWITTER_CLIENT_ID;
      if (!TWITTER_CLIENT_ID) {
        throw new Error('Twitter client ID not configured');
      }

      // Callback URL should always point to the backend API server
      const CALLBACK_URL = window.location.host.includes("localhost")
        ? "http://127.0.0.1:8000/api/twitter/callback"
        : "https://free2z.cash/api/twitter/callback"; // Production backend URL

      const authorizeUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${TWITTER_CLIENT_ID}&redirect_uri=${CALLBACK_URL}&scope=users.read%20follows.read%20tweet.read&state=${state}&code_challenge=${code_challenge}&code_challenge_method=plain&intent=authenticate`;

      // Redirect to Twitter
      window.location.href = authorizeUrl;
    } catch (error: any) {
      console.error('Twitter login error:', error);
      errors.general = error.message || 'Twitter login failed';
      isLoading = false;
    }
  }

  // View transitions
  function switchToLogin() {
    currentView = 'login';
    errors = {};
  }

  function switchToSignup() {
    currentView = 'signup';
    errors = {};
  }

  function switchToResetPassword() {
    currentView = 'resetPassword';
    errors = {};
  }

  // Close modal
  function close() {
    open = false;
    dispatch('close');
  }
  // Toggle password visibility
  function togglePasswordVisibility() {
    showPassword = !showPassword;
  }

  function toggleConfirmPasswordVisibility() {
    showConfirmPassword = !showConfirmPassword;
  }

  // Calculate password strength
  function getPasswordStrength(password: string): { score: number; feedback: string } {
    if (!password) return { score: 0, feedback: '' };

    let score = 0;
    let feedback = [];

    if (password.length >= 8) score += 1;
    else feedback.push(t('auth.passwordStrength.requirements.length'));

    if (/[a-z]/.test(password)) score += 1;
    else feedback.push(t('auth.passwordStrength.requirements.lowercase'));

    if (/[A-Z]/.test(password)) score += 1;
    else feedback.push(t('auth.passwordStrength.requirements.uppercase'));

    if (/\d/.test(password)) score += 1;
    else feedback.push(t('auth.passwordStrength.requirements.number'));

    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) score += 1;
    else feedback.push(t('auth.passwordStrength.requirements.special'));

    const feedbackText = feedback.length
      ? `${t('auth.passwordStrength.weak').replace('{missing}', feedback.join(', '))}`
      : t('auth.passwordStrength.strong');

    return { score, feedback: feedbackText };
  }

  $: passwordStrength = currentView === 'signup' ? getPasswordStrength(password) : { score: 0, feedback: '' };
</script>

{#snippet AuthTitleText()}
  {#if currentView === 'login'}
    {t('auth.loginTitle')}
  {:else if currentView === 'signup'}
    {t('auth.signupTitle')}
  {:else if currentView === 'resetPassword'}
    {t('auth.resetPasswordTitle')}
  {:else if currentView === 'checkEmail'}
    {t('auth.checkEmailTitle')}
  {/if}
{/snippet}

{#snippet AuthBody()}
  <div class="p-4 md:p-0">
    {#if currentView === 'login'}
      <!-- LOGIN VIEW -->

      <!-- Twitter Login -->
      <div class="mb-6">
        <Button
          variant="default"
          type="button"
          class="w-full gap-3 bg-black text-white hover:bg-neutral-900"
          onclick={handleTwitterLogin}
          disabled={isLoading}
        >
          <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
          </svg>
          {t('auth.twitterSignIn')}
        </Button>
        <div class="my-6 flex items-center text-sm text-(--f2z-text-secondary)">
          <div class="h-px flex-1 bg-(--f2z-border-primary)"></div>
          <span class="px-4">or</span>
          <div class="h-px flex-1 bg-(--f2z-border-primary)"></div>
        </div>
      </div>

      <!-- Login Form -->
      <form on:submit|preventDefault={handleSubmit} class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <Label forId="username">{t('auth.username')}</Label>
          <Input
            id="username"
            type="text"
            bind:value={username}
            placeholder={t('auth.usernamePlaceholder')}
            disabled={isLoading}
            class={errors.username ? 'border-red-500' : ''}
          />
          {#if errors.username}
            <p class="m-0 text-sm text-red-500">{errors.username}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <Label forId="password">{t('auth.password')}</Label>
          <div class="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              bind:value={password}
              placeholder={t('auth.passwordPlaceholder')}
              disabled={isLoading}
              class={errors.password ? 'border-red-500' : ''}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              class="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 text-(--f2z-text-secondary) hover:text-(--f2z-text-primary) hover:bg-transparent"
              onclick={togglePasswordVisibility}
              disabled={isLoading}
            >
              {#if showPassword}
                <EyeOff class="h-4 w-4" />
              {:else}
                <Eye class="h-4 w-4" />
              {/if}
            </Button>
          </div>
          {#if errors.password}
            <p class="m-0 text-sm text-red-500">{errors.password}</p>
          {/if}
        </div>

        <!-- Forgot Password Link -->
        <div class="-mt-2 text-right">
          <Button
            variant="link"
            type="button"
            class="h-auto p-0 text-(--f2z-accent-primary)"
            onclick={switchToResetPassword}
            disabled={isLoading}
          >
            {t('auth.forgotPassword')}
          </Button>
        </div>

        <!-- General Error -->
        {#if errors.general}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <p class="m-0">{errors.general}</p>
          </div>
        {/if}

        <!-- Submit Button -->
        <Button
          type="submit"
          class="w-full"
          disabled={isLoading || !username || !password}
        >
          {#if isLoading}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {t('auth.signingIn')}
          {:else}
            {t('auth.logIn')}
          {/if}
        </Button>

        <!-- Sign up link -->
        <p class="mt-0 text-center text-sm text-(--f2z-text-secondary)">
          {t('auth.needAccount')}
          <Button
            variant="link"
            type="button"
            class="h-auto p-0 text-(--f2z-accent-primary)"
            onclick={switchToSignup}
            disabled={isLoading}
          >
            {t('auth.signUpLink')}
          </Button>
        </p>
      </form>

    {:else if currentView === 'signup'}
      <!-- SIGNUP VIEW -->

      <!-- Twitter Login -->
      <div class="mb-6">
        <Button
          variant="default"
          type="button"
          class="w-full gap-3 bg-black text-white hover:bg-neutral-900"
          onclick={handleTwitterLogin}
          disabled={isLoading}
        >
          <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
          </svg>
          {t('auth.twitterSignUp')}
        </Button>
        <div class="my-6 flex items-center text-sm text-(--f2z-text-secondary)">
          <div class="h-px flex-1 bg-(--f2z-border-primary)"></div>
          <span class="px-4">or</span>
          <div class="h-px flex-1 bg-(--f2z-border-primary)"></div>
        </div>
      </div>

      <!-- Signup Form -->
      <form on:submit|preventDefault={handleSubmit} class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <Label forId="signup-username">{t('auth.username')}</Label>
          <Input
            id="signup-username"
            type="text"
            bind:value={username}
            placeholder={t('auth.signupUsernamePlaceholder')}
            disabled={isLoading}
            class={errors.username ? 'border-red-500' : ''}
          />
          {#if errors.username}
            <p class="m-0 text-sm text-red-500">{errors.username}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <Label forId="signup-password">{t('auth.password')}</Label>
          <div class="relative">
            <Input
              id="signup-password"
              type={showPassword ? 'text' : 'password'}
              bind:value={password}
              placeholder={t('auth.signupPasswordPlaceholder')}
              disabled={isLoading}
              class={errors.password ? 'border-red-500' : ''}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              class="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 text-(--f2z-text-secondary) hover:text-(--f2z-text-primary) hover:bg-transparent"
              onclick={togglePasswordVisibility}
              disabled={isLoading}
            >
              {#if showPassword}
                <EyeOff class="h-4 w-4" />
              {:else}
                <Eye class="h-4 w-4" />
              {/if}
            </Button>
          </div>
          {#if errors.password}
            <p class="m-0 text-sm text-red-500">{errors.password}</p>
          {/if}

          <!-- Password Strength Indicator -->
          {#if password}
            <div class="mt-2">
              <div class="h-1 w-full rounded bg-(--f2z-bg-tertiary)">
                <div
                  class={`h-full rounded transition-all duration-300 ${passwordStrengthColors[passwordStrength.score]}`}
                  style={`width: ${(passwordStrength.score / 5) * 100}%`}
                ></div>
              </div>
              <p class="mt-1 text-xs text-(--f2z-text-secondary)">{passwordStrength.feedback}</p>
            </div>
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <Label forId="confirm-password">{t('auth.confirmPassword')}</Label>
          <div class="relative">
            <Input
              id="confirm-password"
              type={showConfirmPassword ? 'text' : 'password'}
              bind:value={confirmPassword}
              placeholder={t('auth.confirmPasswordPlaceholder')}
              disabled={isLoading}
              class={errors.confirmPassword ? 'border-red-500' : ''}
            />
            <Button
              variant="ghost"
              size="icon"
              type="button"
              class="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 text-(--f2z-text-secondary) hover:text-(--f2z-text-primary) hover:bg-transparent"
              onclick={toggleConfirmPasswordVisibility}
              disabled={isLoading}
            >
              {#if showConfirmPassword}
                <EyeOff class="h-4 w-4" />
              {:else}
                <Eye class="h-4 w-4" />
              {/if}
            </Button>
          </div>
          {#if errors.confirmPassword}
            <p class="m-0 text-sm text-red-500">{errors.confirmPassword}</p>
          {/if}
        </div>

        <div class="flex flex-col gap-2">
          <Label forId="email">{t('auth.emailRecommended')}</Label>
          <Input
            id="email"
            type="email"
            bind:value={email}
            placeholder={t('auth.emailPlaceholder')}
            disabled={isLoading}
            class={errors.email ? 'border-red-500' : ''}
          />
          <p class="m-0 text-xs text-(--f2z-text-secondary)">{t('auth.emailHelp')}</p>
          {#if errors.email}
            <p class="m-0 text-sm text-red-500">{errors.email}</p>
          {/if}
        </div>

        <!-- Terms -->
        <p class="m-0 text-center text-xs text-(--f2z-text-secondary)">
          {t('auth.termsText')}
          <a href="/terms" target="_blank" class="text-(--f2z-accent-primary) no-underline hover:underline">{t('auth.termsLink')}</a>
        </p>

        <!-- General Error -->
        {#if errors.general}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <p class="m-0">{errors.general}</p>
          </div>
        {/if}

        <!-- Submit Button -->
        <Button
          type="submit"
          class="w-full"
          disabled={isLoading || !username || !password || !confirmPassword}
        >
          {#if isLoading}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {t('auth.creatingAccount')}
          {:else}
            {t('auth.signUp')}
          {/if}
        </Button>

        <!-- Login link -->
        <p class="mt-0 text-center text-sm text-(--f2z-text-secondary)">
          {t('auth.haveAccount')}
          <Button
            variant="link"
            type="button"
            class="h-auto p-0 text-(--f2z-accent-primary)"
            onclick={switchToLogin}
            disabled={isLoading}
          >
            {t('auth.signInLink')}
          </Button>
        </p>
      </form>

    {:else if currentView === 'resetPassword'}
      <!-- PASSWORD RESET VIEW -->
      <form on:submit|preventDefault={handleSubmit} class="flex flex-col gap-4">
        <p class="mb-6 text-center text-sm leading-6 text-(--f2z-text-secondary)">
          {t('auth.resetPasswordDescription')}
        </p>

        <div class="flex flex-col gap-2">
          <Label forId="reset-email">{t('auth.email')}</Label>
          <Input
            id="reset-email"
            type="email"
            bind:value={resetEmail}
            placeholder={t('auth.emailPlaceholder')}
            disabled={isLoading}
            class={errors.email ? 'border-red-500' : ''}
          />
          {#if errors.email}
            <p class="m-0 text-sm text-red-500">{errors.email}</p>
          {/if}
        </div>

        <!-- General Error -->
        {#if errors.general}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <p class="m-0">{errors.general}</p>
          </div>
        {/if}

        <!-- Submit Button -->
        <Button
          type="submit"
          class="w-full"
          disabled={isLoading || !resetEmail}
        >
          {#if isLoading}
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {t('auth.sending')}
          {:else}
            {t('auth.sendResetLink')}
          {/if}
        </Button>

        <!-- Back to login -->
        <p class="mt-0 text-center text-sm text-(--f2z-text-secondary)">
          {t('auth.rememberPassword')}
          <Button
            variant="link"
            type="button"
            class="h-auto p-0 text-(--f2z-accent-primary)"
            onclick={switchToLogin}
            disabled={isLoading}
          >
            {t('auth.signInLink')}
          </Button>
        </p>
      </form>

    {:else if currentView === 'checkEmail'}
      <!-- EMAIL VERIFICATION VIEW -->
      <div class="space-y-4 text-center">
        <p class="m-0 text-sm leading-6 text-(--f2z-text-secondary)">
          {t('auth.checkEmailDescription')}
        </p>
        <p class="m-0 wrap-break-word rounded-md bg-(--f2z-bg-tertiary) p-3 text-base font-semibold text-(--f2z-text-primary)">
          {pendingEmail}
        </p>
        <p class="m-0 text-sm leading-6 text-(--f2z-text-secondary)">
          {t('auth.checkEmailInstruction')}
        </p>

        <!-- General Error -->
        {#if errors.general}
          <div class="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <p class="m-0">{errors.general}</p>
          </div>
        {/if}

        <Button
          type="button"
          class="w-full gap-2"
          onclick={handleSubmit}
          disabled={isLoading}
        >
          {#if isLoading}
            <Loader2 class="h-4 w-4 animate-spin" />
            {t('auth.confirming')}
          {:else}
            {t('auth.confirmEmail')}
          {/if}
        </Button>
      </div>
    {/if}

    <!-- Captcha notice -->
    {#if dev}
      <div class="mt-4 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2 text-center text-xs text-yellow-200">
        Development mode: using stubbed reCAPTCHA token
      </div>
    {:else}
      <div class="mt-4 text-center text-xs text-(--f2z-text-secondary)">
        This site is protected by reCAPTCHA and the Google
        <a class="underline" href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>
        and
        <a class="underline" href="https://policies.google.com/terms" target="_blank" rel="noreferrer">Terms of Service</a>
        apply.
      </div>
    {/if}
  </div>
{/snippet}

{#if isDesktop.current}
  <Dialog.Root bind:open onOpenChange={(v) => { if (!v) dispatch('close'); }}>
    <Dialog.Content
      class="sm:max-w-[425px] flex flex-col gap-0 max-h-[90vh] overflow-y-auto"
      interactOutsideBehavior={isRecaptchaPending ? 'ignore' : 'close'}
      escapeKeydownBehavior={isRecaptchaPending ? 'ignore' : 'close'}
      showCloseButton={!isRecaptchaPending}
    >
      <Dialog.Header class="p-6 pb-2">
        <Dialog.Title>
          {@render AuthTitleText()}
        </Dialog.Title>
        <Dialog.Description class="sr-only">
          Authentication
        </Dialog.Description>
      </Dialog.Header>
      {@render AuthBody()}
      </Dialog.Content>
    </Dialog.Root>
{:else}
  <Drawer.Root
    bind:open
    dismissible={!isRecaptchaPending}
    onOpenChange={(v) => { if (!v) dispatch('close'); }}
  >
    <Drawer.Content class="flex flex-col gap-0 max-h-[90vh] overflow-y-auto">
      <Drawer.Header class="p-6 pb-2 text-start">
        <Drawer.Title>
          {@render AuthTitleText()}
        </Drawer.Title>
        <Drawer.Description class="sr-only">
          Authentication
        </Drawer.Description>
      </Drawer.Header>
      {@render AuthBody()}
      <Drawer.Footer class="pt-2">
        <Drawer.Close disabled={isRecaptchaPending}>{t('common.cancel','Cancel')}</Drawer.Close>
      </Drawer.Footer>
    </Drawer.Content>
  </Drawer.Root>
{/if}

<style>
  :global(.grecaptcha-badge) {
    visibility: hidden;
  }
</style>
