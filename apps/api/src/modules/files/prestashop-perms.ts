/**
 * PrestaShop writable-directory preset for the file-manager "Fix permissions"
 * action. PrestaShop refuses to install / breaks at runtime unless these
 * directories (relative to the docroot) are writable by the web-server user.
 *
 * We apply: directories 0775, files 0664, owner www-data:www-data (in container
 * / remote modes — LOCAL host-fs applies only the chmod). This matches the
 * PrestaShop docs' "recursive, group-writable for the var/config/img/… tree".
 */
export const PRESTASHOP_WRITABLE_DIRS = [
  'var',
  'config',
  'img',
  'mails',
  'modules',
  'themes',
  'translations',
  'upload',
  'download',
  'cache',
  'log',
] as const;

/** Dir mode + file mode + owner used by the PrestaShop preset. */
export const PRESTASHOP_DIR_MODE = 0o775;
export const PRESTASHOP_FILE_MODE = 0o664;
export const PRESTASHOP_OWNER = 'www-data:www-data';
