// Installs the libsecret driver for the own mail accounts' passwords (ADR 0011, addendum
// 2026-11-23). It is the app entry's job and not the @curlew/imap entry's: a test that reaches the
// keyring without installing a driver would otherwise block on the session bus. Off Linux there is
// no driver, and `@gjsify/secret-store` then throws, naming the platform.
import '@gjsify/secret-store/libsecret';
