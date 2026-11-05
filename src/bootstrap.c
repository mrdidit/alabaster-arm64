#define _GNU_SOURCE
#include <gtk/gtk.h>
#include <glib/gstdio.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>

extern const unsigned char _binary_payload_tar_gz_start[];
extern const unsigned char _binary_payload_tar_gz_end[];

#ifndef PAYLOAD_SHA256
#error PAYLOAD_SHA256 is required
#endif

#define RUNTIME "nwjs-v0.119.2-linux-arm64"
#define RUNTIME_SHA "892f1a39739d1e83ef042997abc6506e08ef8efe53843185058e71d186535b0b"
#define RUNTIME_URL "https://dl.nwjs.io/v0.119.2/nwjs-v0.119.2-linux-arm64.tar.gz"
#define RUNTIME_SIZE 197618683.0

typedef struct {
    char *root, *stage, *archive, *download, *message, *failure;
    gboolean prepare_only, downloading;
    int lock;
    GMutex mutex;
    GCancellable *cancel;
    GtkWidget *window, *label, *progress, *button, *steam_warning;
} Setup;

/* This only detects the current user's Steam process. Shortcut registration
 * still has to verify Steam's live API after installation. */
static gboolean steam_running_in(const char *proc_root, uid_t owner)
{
    GDir *proc = g_dir_open(proc_root, 0, NULL);
    if (!proc) return FALSE;
    const char *name;
    gboolean found = FALSE;
    while ((name = g_dir_read_name(proc))) {
        if (!name[0] || strspn(name, "0123456789") != strlen(name)) continue;
        char *process = g_build_filename(proc_root, name, NULL);
        struct stat st;
        if (g_stat(process, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == owner) {
            char *comm = g_build_filename(process, "comm", NULL);
            int fd = open(comm, O_RDONLY | O_CLOEXEC);
            char command_name[64] = {0};
            ssize_t count = fd >= 0 ? read(fd, command_name, sizeof(command_name) - 1) : -1;
            if (fd >= 0) close(fd);
            if (count > 0 && !strcmp(g_strchomp(command_name), "steam")) found = TRUE;
            g_free(comm);
        }
        g_free(process);
        if (found) break;
    }
    g_dir_close(proc);
    return found;
}

static gboolean errorf(GError **error, const char *message, const char *path)
{
    g_set_error(error, G_IO_ERROR, g_io_error_from_errno(errno), "%s: %s (%s)", message, path, g_strerror(errno));
    return FALSE;
}

static gboolean directory(const char *path, GError **error)
{
    struct stat st;
    if (g_lstat(path, &st) == 0) {
        if (!S_ISDIR(st.st_mode) || st.st_uid != geteuid()) {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Expected an owned directory: %s", path);
            return FALSE;
        }
        return TRUE;
    }
    if (errno != ENOENT) return errorf(error, "Cannot inspect directory", path);
    if (g_mkdir_with_parents(path, 0700) != 0) return errorf(error, "Cannot create directory", path);
    return TRUE;
}

static void remove_tree(const char *path)
{
    struct stat st;
    if (g_lstat(path, &st) != 0) return;
    if (S_ISDIR(st.st_mode)) {
        GDir *dir = g_dir_open(path, 0, NULL);
        if (dir) {
            const char *name;
            while ((name = g_dir_read_name(dir))) {
                char *child = g_build_filename(path, name, NULL);
                remove_tree(child);
                g_free(child);
            }
            g_dir_close(dir);
        }
        g_rmdir(path);
    } else g_unlink(path);
}

static gboolean command(Setup *s, const char *const *argv, GError **error)
{
    GSubprocess *child = g_subprocess_newv(argv, G_SUBPROCESS_FLAGS_STDOUT_SILENCE | G_SUBPROCESS_FLAGS_STDERR_PIPE, error);
    if (!child) return FALSE;
    char *diagnostic = NULL;
    gboolean ok = g_subprocess_communicate_utf8(child, NULL, s->cancel, NULL, &diagnostic, error);
    if (!ok) {
        g_subprocess_force_exit(child);
        g_subprocess_wait(child, NULL, NULL);
    } else if (!g_subprocess_get_successful(child)) {
        g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "%s failed: %.1000s", argv[0], diagnostic ? diagnostic : "no diagnostic");
        ok = FALSE;
    }
    g_free(diagnostic);
    g_object_unref(child);
    return ok;
}

static gboolean checksum(Setup *s, const char *path, const char *expected, GError **error)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return errorf(error, "Cannot read archive", path);
    GChecksum *hash = g_checksum_new(G_CHECKSUM_SHA256);
    unsigned char data[65536];
    gboolean ok = TRUE;
    for (;;) {
        if (g_cancellable_set_error_if_cancelled(s->cancel, error)) { ok = FALSE; break; }
        ssize_t count = read(fd, data, sizeof(data));
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { ok = errorf(error, "Cannot read archive", path); break; }
        if (!count) break;
        g_checksum_update(hash, data, (gsize)count);
    }
    close(fd);
    if (ok && strcmp(g_checksum_get_string(hash), expected)) {
        g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Checksum mismatch for %s. No runtime was installed.", path);
        ok = FALSE;
    }
    g_checksum_free(hash);
    return ok;
}

static void status(Setup *s, const char *message, gboolean downloading)
{
    g_mutex_lock(&s->mutex);
    g_free(s->message);
    s->message = g_strdup(message);
    s->downloading = downloading;
    g_mutex_unlock(&s->mutex);
    if (s->prepare_only) g_print("%s\n", message);
}

static gboolean runtime_elf(const char *runtime)
{
    char *binary = g_build_filename(runtime, "nw", NULL);
    unsigned char header[20] = {0};
    int fd = open(binary, O_RDONLY | O_CLOEXEC);
    gboolean ok = fd >= 0 && read(fd, header, sizeof(header)) == sizeof(header) &&
        !memcmp(header, "\177ELF\002\001", 6) && header[18] == 183 && header[19] == 0 && access(binary, X_OK) == 0;
    if (fd >= 0) close(fd);
    g_free(binary);
    return ok;
}

static gboolean app_idle(Setup *s, GError **error)
{
    GDir *proc = g_dir_open("/proc", 0, error);
    if (!proc) return FALSE;
    char *prefix = g_build_filename(s->root, "runtime", NULL);
    char *with_slash = g_strconcat(prefix, "/", NULL);
    const char *name;
    gboolean idle = TRUE;
    while ((name = g_dir_read_name(proc))) {
        if (!g_ascii_isdigit(name[0])) continue;
        char *exe = g_build_filename("/proc", name, "exe", NULL);
        char *target = g_file_read_link(exe, NULL);
        if (target && g_str_has_prefix(target, with_slash)) {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_BUSY, "Close Alabaster Dawn and its launcher before running setup again.");
            idle = FALSE;
        }
        g_free(exe); g_free(target);
        if (!idle) break;
    }
    g_free(prefix); g_free(with_slash); g_dir_close(proc);
    return idle;
}

static gboolean unpack_payload(Setup *s, GError **error)
{
    if (!directory(s->root, error)) return FALSE;
    char *resolved = realpath(s->root, NULL);
    if (!resolved) return errorf(error, "Cannot resolve installation directory", s->root);
    g_free(s->root); s->root = resolved;
    char *lock_path = g_build_filename(s->root, ".setup.lock", NULL);
    s->lock = open(lock_path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    g_free(lock_path);
    if (s->lock < 0 || flock(s->lock, LOCK_EX | LOCK_NB) != 0) {
        g_set_error(error, G_IO_ERROR, G_IO_ERROR_BUSY, "Another setup is running, or the setup lock cannot be opened.");
        return FALSE;
    }
    if (!app_idle(s, error)) return FALSE;
    s->stage = g_build_filename(s->root, ".setup-XXXXXX", NULL);
    if (!g_mkdtemp(s->stage)) return errorf(error, "Cannot create setup staging directory", s->stage);
    char *archive = g_build_filename(s->stage, "payload.tar.gz", NULL);
    gsize size = (gsize)(_binary_payload_tar_gz_end - _binary_payload_tar_gz_start);
    char *hash = g_compute_checksum_for_data(G_CHECKSUM_SHA256, _binary_payload_tar_gz_start, size);
    gboolean ok = strcmp(hash, PAYLOAD_SHA256) == 0;
    g_free(hash);
    if (!ok) g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "The embedded launcher payload is damaged.");
    if (ok) ok = g_file_set_contents(archive, (const char *)_binary_payload_tar_gz_start, (gssize)size, error);
    if (ok) {
        const char *argv[] = {"/usr/bin/tar", "--extract", "--gzip", "--no-same-owner", "--no-same-permissions", "--file", archive, "--directory", s->stage, NULL};
        ok = command(s, argv, error);
    }
    g_free(archive);
    return ok;
}

static gboolean ensure_runtime(Setup *s, gboolean *fresh, GError **error)
{
    char *runtime = g_build_filename(s->root, "runtime", RUNTIME, NULL);
    char *marker = g_build_filename(runtime, ".archive-sha256", NULL);
    char *provenance = NULL;
    struct stat st;
    gboolean ready = g_lstat(runtime, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == geteuid() &&
        g_file_get_contents(marker, &provenance, NULL, NULL) &&
        g_strcmp0(provenance, RUNTIME_SHA "\n") == 0 && runtime_elf(runtime);
    g_free(provenance); g_free(marker); g_free(runtime);
    if (ready) { *fresh = FALSE; return TRUE; }

    char *archive = s->archive ? g_strdup(s->archive) : g_build_filename(s->root, "downloads", RUNTIME ".tar.gz", NULL);
    gboolean cached = g_file_test(archive, G_FILE_TEST_IS_REGULAR);
    if (s->archive && !cached) {
        g_set_error(error, G_IO_ERROR, G_IO_ERROR_NOT_FOUND, "The selected runtime archive does not exist: %s", archive);
        g_free(archive); return FALSE;
    }
    if (!cached) {
        g_mutex_lock(&s->mutex);
        s->download = g_build_filename(s->stage, RUNTIME ".tar.gz.part", NULL);
        g_mutex_unlock(&s->mutex);
        status(s, "Downloading the ARM64 runtime…", TRUE);
        const char *argv[] = {"/usr/bin/curl", "--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", "--connect-timeout", "15", "--max-time", "1800", "--retry", "2", "--max-filesize", "268435456", "--output", s->download, "--", RUNTIME_URL, NULL};
        if (!command(s, argv, error)) { g_free(archive); return FALSE; }
        g_free(archive); archive = g_strdup(s->download);
    }
    status(s, "Checking the runtime download…", FALSE);
    if (!checksum(s, archive, RUNTIME_SHA, error)) { g_free(archive); return FALSE; }
    char *directory_path = g_build_filename(s->stage, "runtime", NULL);
    gboolean ok = directory(directory_path, error);
    if (ok) {
        status(s, "Preparing the ARM64 runtime…", FALSE);
        const char *argv[] = {"/usr/bin/tar", "--extract", "--gzip", "--no-same-owner", "--no-same-permissions", "--file", archive, "--directory", directory_path, NULL};
        ok = command(s, argv, error);
    }
    runtime = g_build_filename(directory_path, RUNTIME, NULL);
    if (ok && !runtime_elf(runtime)) {
        g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "The extracted runtime is not an executable Linux ARM64 build.");
        ok = FALSE;
    }
    marker = g_build_filename(runtime, ".archive-sha256", NULL);
    if (ok) ok = g_file_set_contents(marker, RUNTIME_SHA "\n", -1, error);
    g_free(marker); g_free(runtime); g_free(directory_path); g_free(archive);
    *fresh = ok;
    return ok;
}

typedef struct { char *source, *destination, *backup; gboolean old_moved, new_moved; } Move;

static gboolean commit(Setup *s, gboolean runtime, GError **error)
{
    const char *names[] = {"alabaster-dawn.arm64", "launcher.c", "setup.cjs", "save-transfer.cjs", "steam-cloud.cjs", "cloud-sync.cjs", "steam-shortcut.cjs", "uninstall.cjs", "controller-emulation.cjs", "menu", "app/menu", "app/package.json", "runtime/" RUNTIME};
    Move moves[G_N_ELEMENTS(names)] = {0};
    char *app = g_build_filename(s->root, "app", NULL);
    char *runtime_parent = g_build_filename(s->root, "runtime", NULL);
    char *backups = g_build_filename(s->stage, "before", NULL);
    gboolean ok = directory(app, error) && directory(runtime_parent, error) && directory(backups, error) && app_idle(s, error);
    g_free(app); g_free(runtime_parent);
    guint used = 0;
    for (guint i = 0; ok && i < G_N_ELEMENTS(names); i++) {
        if (i == G_N_ELEMENTS(names) - 1 && !runtime) continue;
        char *destination = g_build_filename(s->root, names[i], NULL);
        struct stat st;
        gboolean exists = g_lstat(destination, &st) == 0;
        if (!exists && errno != ENOENT) { ok = errorf(error, "Cannot inspect destination", destination); g_free(destination); break; }
        if (exists && (S_ISLNK(st.st_mode) || st.st_uid != geteuid())) {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Setup will not replace an unowned or symlinked path: %s", destination);
            g_free(destination); ok = FALSE; break;
        }
        if (strcmp(names[i], "app/package.json") == 0 && exists) { g_free(destination); continue; }
        if (g_cancellable_set_error_if_cancelled(s->cancel, error)) { g_free(destination); ok = FALSE; break; }
        Move *move = &moves[used++];
        move->source = g_build_filename(s->stage, names[i], NULL);
        move->destination = destination;
        char *number = g_strdup_printf("%u", i);
        move->backup = g_build_filename(backups, number, NULL); g_free(number);
        if (exists) {
            if (g_rename(destination, move->backup) != 0) { ok = errorf(error, "Cannot retain previous file", destination); break; }
            move->old_moved = TRUE;
        }
        if (g_rename(move->source, destination) != 0) { ok = errorf(error, "Cannot install file", destination); break; }
        move->new_moved = TRUE;
    }
    if (!ok) {
        for (gint i = (gint)used - 1; i >= 0; i--) {
            Move *move = &moves[i];
            if (move->new_moved) remove_tree(move->destination);
            if (move->old_moved && g_rename(move->backup, move->destination) != 0) {
                g_warning("Previous installation retained at %s; could not restore %s", move->backup, move->destination);
                g_free(s->stage); s->stage = NULL;
            }
        }
    }
    for (guint i = 0; i < used; i++) { g_free(moves[i].source); g_free(moves[i].destination); g_free(moves[i].backup); }
    g_free(backups);
    return ok;
}

static gboolean prepare(Setup *s, GError **error)
{
    gboolean fresh = FALSE;
    if (!ensure_runtime(s, &fresh, error)) return FALSE;
    status(s, "Installing the launcher…", FALSE);
    if (!commit(s, fresh, error)) return FALSE;
    char *pending = g_build_filename(s->root, ".steam-shortcut-pending", NULL);
    gboolean marked = g_file_set_contents(pending, PAYLOAD_SHA256 "\n", -1, error);
    g_free(pending);
    if (!marked) return FALSE;
    status(s, "Ready", FALSE);
    return TRUE;
}

static char *desktop_exec(const char *binary)
{
    GString *exec = g_string_new("\"");
    for (const char *c = binary; *c; c++) {
        if (*c == '%') g_string_append_c(exec, '%');
        if (strchr("\\\"`$", *c)) g_string_append_c(exec, '\\');
        g_string_append_c(exec, *c);
    }
    g_string_append_c(exec, '"');
    return g_string_free(exec, FALSE);
}

static gboolean legacy_application_entry(GKeyFile *key, const char *current_exec)
{
    char *name = g_key_file_get_string(key, "Desktop Entry", "Name", NULL);
    char *type = g_key_file_get_string(key, "Desktop Entry", "Type", NULL);
    char *exec = g_key_file_get_string(key, "Desktop Entry", "Exec", NULL);
    char *legacy_binary = g_build_filename(g_get_home_dir(), "Games", "Alabaster-Dawn-ARM64", "alabaster-dawn.arm64", NULL);
    char *legacy_exec = desktop_exec(legacy_binary);
    gboolean match = g_strcmp0(name, "Alabaster Dawn ARM64") == 0 &&
        g_strcmp0(type, "Application") == 0 &&
        (g_strcmp0(exec, current_exec) == 0 || g_strcmp0(exec, legacy_exec) == 0);
    g_free(name); g_free(type); g_free(exec); g_free(legacy_binary); g_free(legacy_exec);
    return match;
}

static gboolean write_application_entry(const char *folder, const char *filename,
                                        const char *exec, const char *icon,
                                        gboolean executable, GError **error)
{
    if (!directory(folder, error)) return FALSE;
    char *entry = g_build_filename(folder, filename, NULL);
    GKeyFile *key = g_key_file_new();
    struct stat existing;
    gboolean ok = TRUE;
    if (g_lstat(entry, &existing) == 0) {
        if (!S_ISREG(existing.st_mode) || existing.st_uid != geteuid()) {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Shortcut is not an owned regular file: %s", entry);
            ok = FALSE;
        } else if (!g_key_file_load_from_file(key, entry, G_KEY_FILE_NONE, error)) {
            ok = FALSE;
        } else if (!g_key_file_get_boolean(key, "Desktop Entry", "X-Alabaster-ARM64-Managed", NULL) &&
                   !legacy_application_entry(key, exec)) {
            g_set_error(error, G_IO_ERROR, G_IO_ERROR_EXISTS, "An unrelated shortcut already exists and was kept: %s", entry);
            ok = FALSE;
        }
    } else if (errno != ENOENT) {
        ok = errorf(error, "Cannot inspect shortcut", entry);
    }
    if (ok) {
        g_key_file_set_string(key, "Desktop Entry", "Type", "Application");
        g_key_file_set_string(key, "Desktop Entry", "Name", "Alabaster Dawn ARM64");
        g_key_file_set_string(key, "Desktop Entry", "Exec", exec);
        g_key_file_set_string(key, "Desktop Entry", "Categories", "Game;");
        g_key_file_set_boolean(key, "Desktop Entry", "Terminal", FALSE);
        g_key_file_set_boolean(key, "Desktop Entry", "X-Alabaster-ARM64-Managed", TRUE);
        g_key_file_set_string(key, "Desktop Entry", "Icon", icon);
        ok = g_key_file_save_to_file(key, entry, error);
        if (ok && executable && g_chmod(entry, 0755) != 0)
            ok = errorf(error, "Cannot make Desktop shortcut executable", entry);
    }
    g_key_file_free(key); g_free(entry);
    return ok;
}

static gboolean register_application(Setup *s, GError **error)
{
    char *standard = g_build_filename(g_get_user_data_dir(), "alabaster-dawn-launcher", NULL);
    char *resolved = realpath(standard, NULL);
    gboolean is_default = resolved && !strcmp(resolved, s->root);
    g_free(resolved); g_free(standard);
    if (!is_default) return TRUE;
    char *binary = g_build_filename(s->root, "alabaster-dawn.arm64", NULL);
    char *exec = desktop_exec(binary);
    char *icon = g_build_filename(s->root, "app/menu/assets/steam/logo.png", NULL);
    char *apps = g_build_filename(g_get_user_data_dir(), "applications", NULL);
    GString *failures = g_string_new(NULL);
    GError *failure = NULL;
    if (!write_application_entry(apps, "alabaster-dawn-arm64.desktop", exec, icon, FALSE, &failure)) {
        g_string_append_printf(failures, "Applications menu: %s", failure->message);
        g_clear_error(&failure);
    }
    const char *desktop = g_get_user_special_dir(G_USER_DIRECTORY_DESKTOP);
    if (desktop && *desktop) {
        // XDG represents a disabled Desktop as HOME. Never put a shortcut there.
        char *desktop_path = realpath(desktop, NULL);
        if (!desktop_path) desktop_path = g_canonicalize_filename(desktop, NULL);
        char *home_path = realpath(g_get_home_dir(), NULL);
        if (!home_path) home_path = g_canonicalize_filename(g_get_home_dir(), NULL);
        if (strcmp(desktop_path, home_path) &&
            !write_application_entry(desktop, "Alabaster-Dawn-ARM64.desktop", exec, icon, TRUE, &failure)) {
            if (failures->len) g_string_append_c(failures, '\n');
            g_string_append_printf(failures, "Desktop: %s", failure->message);
            g_clear_error(&failure);
        }
        g_free(desktop_path); g_free(home_path);
    }
    gboolean ok = failures->len == 0;
    if (!ok) g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "%s", failures->str);
    g_string_free(failures, TRUE); g_free(exec);
    g_free(icon); g_free(binary); g_free(apps);
    return ok;
}

static void worker(GTask *task, gpointer source, gpointer task_data, GCancellable *cancel)
{
    (void)source; (void)cancel;
    Setup *s = task_data;
    GError *error = NULL;
    if (prepare(s, &error)) g_task_return_boolean(task, TRUE);
    else g_task_return_error(task, error);
}

static void cancel_clicked(GtkButton *button, gpointer data)
{
    Setup *s = data;
    g_cancellable_cancel(s->cancel);
    gtk_widget_set_sensitive(GTK_WIDGET(button), FALSE);
    gtk_label_set_text(GTK_LABEL(s->label), "Cancelling…");
}

static gboolean close_requested(GtkWidget *widget, GdkEvent *event, gpointer data)
{
    (void)widget; (void)event;
    cancel_clicked(GTK_BUTTON(((Setup *)data)->button), data);
    return TRUE;
}

static void setup_window(Setup *s, gboolean steam_running)
{
    s->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(s->window), "Alabaster ARM64 — Setup");
    gtk_window_set_default_size(GTK_WINDOW(s->window), 800, 600);
    gtk_container_set_border_width(GTK_CONTAINER(s->window), 24);
    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 16);
    gtk_widget_set_halign(box, GTK_ALIGN_CENTER);
    gtk_widget_set_valign(box, GTK_ALIGN_CENTER);
    gtk_widget_set_size_request(box, 520, -1);
    gtk_container_add(GTK_CONTAINER(s->window), box);
    s->label = gtk_label_new("Preparing launcher…");
    gtk_label_set_line_wrap(GTK_LABEL(s->label), TRUE);
    s->progress = gtk_progress_bar_new();
    s->button = gtk_button_new_with_label("Cancel");
    gtk_box_pack_start(GTK_BOX(box), s->label, TRUE, TRUE, 0);
    gtk_box_pack_start(GTK_BOX(box), s->progress, FALSE, TRUE, 0);
    if (!steam_running) {
        s->steam_warning = gtk_info_bar_new();
        gtk_info_bar_set_message_type(GTK_INFO_BAR(s->steam_warning), GTK_MESSAGE_WARNING);
        GtkWidget *notice = gtk_label_new("Steam was not detected. Installation can continue, but Steam must be open to add the launcher to your library.");
        gtk_label_set_line_wrap(GTK_LABEL(notice), TRUE);
        gtk_label_set_max_width_chars(GTK_LABEL(notice), 56);
        gtk_label_set_xalign(GTK_LABEL(notice), 0.0f);
        gtk_container_add(GTK_CONTAINER(gtk_info_bar_get_content_area(GTK_INFO_BAR(s->steam_warning))), notice);
        gtk_box_pack_start(GTK_BOX(box), s->steam_warning, FALSE, TRUE, 0);
    }
    gtk_box_pack_start(GTK_BOX(box), s->button, FALSE, FALSE, 0);
    g_signal_connect(s->button, "clicked", G_CALLBACK(cancel_clicked), s);
    g_signal_connect(s->window, "delete-event", G_CALLBACK(close_requested), s);
    gtk_window_fullscreen(GTK_WINDOW(s->window));
    gtk_widget_show_all(s->window);
}

static gboolean progress_tick(gpointer data)
{
    Setup *s = data;
    if (g_cancellable_is_cancelled(s->cancel)) return G_SOURCE_CONTINUE;
    g_mutex_lock(&s->mutex);
    char *message = g_strdup(s->message ? s->message : "Preparing launcher…");
    gboolean downloading = s->downloading;
    char *download = g_strdup(s->download);
    g_mutex_unlock(&s->mutex);
    if (downloading && download) {
        struct stat st;
        if (stat(download, &st) == 0) {
            char *label = g_strdup_printf("%s\n%.1f of %.1f MiB", message, st.st_size / 1048576.0, RUNTIME_SIZE / 1048576.0);
            gtk_label_set_text(GTK_LABEL(s->label), label); g_free(label);
            gtk_progress_bar_set_fraction(GTK_PROGRESS_BAR(s->progress), MIN(1.0, st.st_size / RUNTIME_SIZE));
        }
    } else {
        gtk_label_set_text(GTK_LABEL(s->label), message);
        gtk_progress_bar_pulse(GTK_PROGRESS_BAR(s->progress));
    }
    g_free(message); g_free(download);
    return G_SOURCE_CONTINUE;
}

static void completed(GObject *source, GAsyncResult *result, gpointer data)
{
    (void)source;
    Setup *s = data;
    GError *error = NULL;
    if (!g_task_propagate_boolean(G_TASK(result), &error)) {
        s->failure = g_strdup(error->message);
        if (!g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
            GtkWidget *dialog = gtk_message_dialog_new(GTK_WINDOW(s->window), GTK_DIALOG_MODAL,
                GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE, "Setup did not finish");
            gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", error->message);
            gtk_dialog_run(GTK_DIALOG(dialog)); gtk_widget_destroy(dialog);
        }
        g_clear_error(&error);
    }
    gtk_main_quit();
}

int main(int argc, char **argv)
{
    Setup s = {.lock = -1};
    GOptionEntry options[] = {
        {"install-root", 0, 0, G_OPTION_ARG_FILENAME, &s.root, "Install in this directory", "DIRECTORY"},
        {"runtime-archive", 0, 0, G_OPTION_ARG_FILENAME, &s.archive, "Use an already downloaded runtime archive", "FILE"},
        {"prepare-only", 0, 0, G_OPTION_ARG_NONE, &s.prepare_only, "Prepare files without opening the launcher", NULL},
        {NULL}
    };
    GError *error = NULL;
    GOptionContext *options_context = g_option_context_new("— Alabaster Dawn ARM64 setup");
    g_option_context_add_main_entries(options_context, options, NULL);
    if (!g_option_context_parse(options_context, &argc, &argv, &error)) {
        g_printerr("%s\n", error->message); g_error_free(error); return 2;
    }
    g_option_context_free(options_context);
    if (argc != 1) { g_printerr("Unexpected argument. Use --help for setup options.\n"); return 2; }
    if (!s.root) s.root = g_build_filename(g_get_user_data_dir(), "alabaster-dawn-launcher", NULL);
    char *absolute = g_canonicalize_filename(s.root, NULL); g_free(s.root); s.root = absolute;
    if (!strcmp(s.root, "/") || !strcmp(s.root, g_get_home_dir())) {
        g_printerr("Choose a dedicated launcher directory.\n"); return 2;
    }
    if (s.archive) { absolute = g_canonicalize_filename(s.archive, NULL); g_free(s.archive); s.archive = absolute; }
    g_mutex_init(&s.mutex);
    s.cancel = g_cancellable_new();
    gboolean ok = unpack_payload(&s, &error);
    if (ok && s.prepare_only) ok = prepare(&s, &error);
    else if (ok) {
        char *fontconfig = g_build_filename(s.stage, "app/menu/assets/fonts/fonts.conf", NULL);
        g_setenv("FONTCONFIG_FILE", fontconfig, TRUE); g_free(fontconfig);
        if (!gtk_init_check(NULL, NULL)) {
            g_set_error(&error, G_IO_ERROR, G_IO_ERROR_FAILED, "Open setup from Desktop Mode or Steam; no graphical display is available.");
            ok = FALSE;
        } else {
            setup_window(&s, steam_running_in("/proc", geteuid()));
            guint timer = g_timeout_add(150, progress_tick, &s);
            GTask *task = g_task_new(NULL, s.cancel, completed, &s);
            g_task_set_task_data(task, &s, NULL);
            g_task_set_return_on_cancel(task, FALSE);
            g_task_run_in_thread(task, worker); g_object_unref(task);
            gtk_main(); g_source_remove(timer); gtk_widget_destroy(s.window);
            ok = s.failure == NULL;
        }
    }
    if (error) { g_printerr("Setup: %s\n", error->message); g_clear_error(&error); }
    if (s.failure) g_printerr("Setup: %s\n", s.failure);
    gboolean shortcuts_ok = TRUE;
    if (ok && !register_application(&s, &error)) {
        shortcuts_ok = FALSE;
        g_printerr("Launcher installed; shortcut creation incomplete: %s\n", error->message);
        if (!s.prepare_only) {
            GtkWidget *dialog = gtk_message_dialog_new(NULL, GTK_DIALOG_MODAL,
                GTK_MESSAGE_WARNING, GTK_BUTTONS_CLOSE, "Launcher installed; shortcuts incomplete");
            gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog),
                "%s\n\nExisting unrelated shortcuts were not replaced. The launcher can still be opened.", error->message);
            gtk_dialog_run(GTK_DIALOG(dialog)); gtk_widget_destroy(dialog);
        }
        g_clear_error(&error);
    }
    if (s.stage) remove_tree(s.stage);
    if (s.lock >= 0) { flock(s.lock, LOCK_UN); close(s.lock); }
    if (!ok) return 1;
    if (s.prepare_only) {
        g_print("Launcher files installed at %s\n", s.root);
        return shortcuts_ok ? 0 : 1;
    }
    char *launcher = g_build_filename(s.root, "alabaster-dawn.arm64", NULL);
    char *const command_line[] = {launcher, NULL};
    execv(launcher, command_line);
    g_printerr("Cannot open launcher: %s\n", g_strerror(errno));
    return 1;
}
