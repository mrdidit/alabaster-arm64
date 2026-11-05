/* Includes the production bootstrap; no payload installation or network calls. */
#define PAYLOAD_SHA256 "test-fixture"
#define main bootstrap_entry_point
#include "../src/bootstrap.c"
#include <gdk/gdkx.h>
#undef main

const unsigned char _binary_payload_tar_gz_start[] = {0};
const unsigned char _binary_payload_tar_gz_end[] = {0};

static void fixture_process(const char *root, const char *pid, const char *comm)
{
    char *dir = g_build_filename(root, pid, NULL);
    g_assert_cmpint(g_mkdir(dir, 0700), ==, 0);
    if (comm) {
        char *file = g_build_filename(dir, "comm", NULL);
        g_assert_true(g_file_set_contents(file, comm, -1, NULL));
        g_free(file);
    }
    g_free(dir);
}

static void detector_test(void)
{
    char *root = g_dir_make_tmp("alabaster-steam-process-test-XXXXXX", NULL);
    g_assert_nonnull(root);
    g_assert_false(steam_running_in(root, geteuid()));
    fixture_process(root, "100", "steamwebhelper\n");
    fixture_process(root, "101", "steam.sh\n");
    fixture_process(root, "102", NULL);
    fixture_process(root, "not-a-pid", "steam\n");
    g_assert_false(steam_running_in(root, geteuid()));
    fixture_process(root, "103", "steam\n");
    g_assert_true(steam_running_in(root, geteuid()));
    g_assert_false(steam_running_in(root, geteuid() + 1));
    char *missing = g_build_filename(root, "missing", NULL);
    g_assert_false(steam_running_in(missing, geteuid()));
    g_free(missing);
    remove_tree(root);
    g_free(root);
    g_print("{\"detector_checks\":5,\"passed\":true}\n");
}

static void settle_window(Setup *s)
{
    gint64 deadline = g_get_monotonic_time() + 5 * G_TIME_SPAN_SECOND;
    do {
        while (gtk_events_pending()) gtk_main_iteration();
        GdkWindow *window = gtk_widget_get_window(s->window);
        if (window && (gdk_window_get_state(window) & GDK_WINDOW_STATE_FULLSCREEN)) {
            GdkMonitor *monitor = gdk_display_get_monitor_at_window(gdk_window_get_display(window), window);
            GdkRectangle bounds;
            int width, height;
            gdk_monitor_get_geometry(monitor, &bounds);
            gtk_window_get_size(GTK_WINDOW(s->window), &width, &height);
            if (width == bounds.width && height == bounds.height) return;
        }
        g_usleep(10000);
    } while (g_get_monotonic_time() < deadline);
    GdkWindow *window = gtk_widget_get_window(s->window);
    if (window) {
        GdkDisplay *display = gdk_window_get_display(window);
        GdkMonitor *monitor = gdk_display_get_monitor_at_window(display, window);
        GdkRectangle bounds;
        GtkAllocation allocation;
        int width, height, x, y, gdk_width, gdk_height;
        gdk_monitor_get_geometry(monitor, &bounds);
        gtk_window_get_size(GTK_WINDOW(s->window), &width, &height);
        gdk_window_get_geometry(window, &x, &y, &gdk_width, &gdk_height);
        gtk_widget_get_allocation(s->window, &allocation);
        g_printerr("Fullscreen diagnostic: display=%s state=0x%x gtk_size=%dx%d gdk_geometry=%d,%d %dx%d allocation=%d,%d %dx%d monitor=%d,%d %dx%d border=%u\n",
                   gdk_display_get_name(display), (unsigned)gdk_window_get_state(window),
                   width, height, x, y, gdk_width, gdk_height,
                   allocation.x, allocation.y, allocation.width, allocation.height,
                   bounds.x, bounds.y, bounds.width, bounds.height,
                   gtk_container_get_border_width(GTK_CONTAINER(s->window)));
    } else g_printerr("Fullscreen diagnostic: no realized GdkWindow\n");
    g_error("The private window manager did not apply fullscreen within five seconds.");
}

static void window_test(gboolean steam_running)
{
    Setup s = {.cancel = g_cancellable_new()};
    g_mutex_init(&s.mutex);
    setup_window(&s, steam_running);
    settle_window(&s);
    GdkWindow *window = gtk_widget_get_window(s.window);
    GdkDisplay *display = gdk_window_get_display(window);
    g_assert_true(GDK_IS_X11_DISPLAY(display));
    g_assert_cmpstr(gdk_display_get_name(display), ==, g_getenv("DISPLAY"));
    GdkMonitor *monitor = gdk_display_get_monitor_at_window(display, window);
    GdkRectangle bounds;
    gdk_monitor_get_geometry(monitor, &bounds);
    g_assert_cmpint(bounds.width, ==, 1280);
    g_assert_cmpint(bounds.height, ==, 720);
    int width, height;
    gtk_window_get_size(GTK_WINDOW(s.window), &width, &height);
    g_assert_cmpint(width, ==, bounds.width);
    g_assert_cmpint(height, ==, bounds.height);
    g_assert_cmpint(s.steam_warning != NULL, ==, !steam_running);
    if (s.steam_warning) g_assert_true(gtk_widget_get_visible(s.steam_warning));
    g_assert_true(gtk_widget_is_sensitive(s.button));
    g_assert_false(g_cancellable_is_cancelled(s.cancel));
    status(&s, "Fixture installation continues", FALSE);
    progress_tick(&s);
    g_assert_cmpstr(gtk_label_get_text(GTK_LABEL(s.label)), ==, "Fixture installation continues");
    if (s.steam_warning) g_assert_true(gtk_widget_get_visible(s.steam_warning));
    gtk_button_clicked(GTK_BUTTON(s.button));
    g_assert_true(g_cancellable_is_cancelled(s.cancel));
    g_assert_false(gtk_widget_is_sensitive(s.button));
    g_print("{\"steam_detected\":%s,\"fullscreen\":true,\"width\":%d,\"height\":%d,\"warning_visible\":%s,\"progress_continues\":true,\"cancel_works\":true}\n",
            steam_running ? "true" : "false", width, height, s.steam_warning ? "true" : "false");
    gtk_widget_destroy(s.window);
    g_free(s.message);
    g_object_unref(s.cancel);
    g_mutex_clear(&s.mutex);
}

int main(int argc, char **argv)
{
    detector_test();
    if (argc == 2 && !strcmp(argv[1], "--gui")) {
        if (!gtk_init_check(NULL, NULL)) return 77;
        window_test(FALSE);
        window_test(TRUE);
    } else if (argc != 1) return 2;
    return 0;
}
