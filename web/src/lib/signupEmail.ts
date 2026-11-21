// The email typed into the landing page's hero form is carried to the signup form through
// sessionStorage, not the URL, so it never lands in server logs or analytics page paths.
const KEY = 'cb.signup.email';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null; // storage can be blocked; signup still works, just without the prefill
  }
}

export function rememberSignupEmail(email: unknown, s: Store | null = store()): void {
  if (!s || typeof email !== 'string' || !email.trim()) return;
  try {
    s.setItem(KEY, email.trim());
  } catch {
    /* quota or privacy mode: nothing to do */
  }
}

export function takeSignupEmail(s: Store | null = store()): string {
  if (!s) return '';
  try {
    const value = s.getItem(KEY) ?? '';
    s.removeItem(KEY);
    return value;
  } catch {
    return '';
  }
}
