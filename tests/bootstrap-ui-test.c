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
        file = g_build_filename(dir, "stat", NULL);
        g_assert_true(g_file_set_contents(file, "1 (fixture) S 0 0 0\n", -1, NULL));
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
    fixture_process(root, "104", "steam\n");
    char *state = g_build_filename(root, "104", "stat", NULL);
    g_assert_true(g_file_set_contents(state, "104 (steam) Z 0 0 0\n", -1, NULL));
    g_assert_false(steam_running_in(root, geteuid()));
    g_assert_true(g_file_set_contents(state, "104 (steam) X 0 0 0\n", -1, NULL));
    g_assert_false(steam_running_in(root, geteuid()));
    g_assert_cmpint(g_unlink(state), ==, 0);
    g_assert_false(steam_running_in(root, geteuid()));
    g_free(state);
    fixture_process(root, "103", "steam\n");
    g_assert_true(steam_running_in(root, geteuid()));
    g_assert_false(steam_running_in(root, geteuid() + 1));
    char *missing = g_build_filename(root, "missing", NULL);
    g_assert_false(steam_running_in(missing, geteuid()));
    g_free(missing);
    remove_tree(root);
    g_free(root);
    g_print("{\"detector_checks\":8,\"passed\":true}\n");
}

typedef struct {
    Setup *setup;
    int responses[2], count, seen;
    gboolean launch_ok;
    int launches;
} PromptProbe;

static PromptProbe *active_prompt;

static void x11_diagnostic(char **argv)
{
    char *output = NULL, *errors = NULL;
    GError *error = NULL;
    int wait_status = 0;
    gboolean ok = g_spawn_sync(NULL, argv, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL,
                               &output, &errors, &wait_status, &error);
    g_printerr("X11 diagnostic %s: launched=%d status=%d\n%.12000s\n%.2000s\n%s\n",
               argv[0], ok, wait_status, output ? output : "", errors ? errors : "",
               error ? error->message : "");
    g_free(output); g_free(errors); g_clear_error(&error);
}

static gboolean fake_start(char **environment, GError **error)
{
    g_assert_nonnull(active_prompt);
    g_assert_true(environment == active_prompt->setup->steam_environment);
    g_assert_cmpstr(environment[0], ==, "FONTCONFIG_FILE=original-fixture-fonts");
    active_prompt->launches++;
    if (!active_prompt->launch_ok)
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, "Synthetic Steam launch failure");
    return active_prompt->launch_ok;
}

static gboolean answer_prompt(gpointer data)
{
    PromptProbe *probe = data;
    GList *windows = gtk_window_list_toplevels();
    GtkWidget *dialog = NULL;
    for (GList *item = windows; item; item = item->next)
        if (GTK_IS_MESSAGE_DIALOG(item->data) && gtk_widget_get_visible(item->data) &&
            gtk_window_get_transient_for(GTK_WINDOW(item->data)) == GTK_WINDOW(probe->setup->window)) {
            dialog = item->data;
            break;
        }
    g_list_free(windows);
    if (!dialog) return G_SOURCE_CONTINUE;
    g_assert_cmpint(probe->seen, <, probe->count);
    g_assert_true(gtk_window_get_modal(GTK_WINDOW(dialog)));
    g_assert_true(gtk_window_get_default_widget(GTK_WINDOW(dialog)) ==
                  gtk_dialog_get_widget_for_response(GTK_DIALOG(dialog), GTK_RESPONSE_CANCEL));
    if (!probe->seen) g_assert_cmpint(probe->launches, ==, 0);
    gtk_dialog_response(GTK_DIALOG(dialog), probe->responses[probe->seen++]);
    return G_SOURCE_CONTINUE;
}

static void prompt_test(gboolean running, int response, gboolean launch_ok, int failure_response)
{
    char *original_environment[] = {"FONTCONFIG_FILE=original-fixture-fonts", NULL};
    Setup s = {.cancel = g_cancellable_new(), .steam_environment = original_environment};
    setup_window(&s, running);
    PromptProbe probe = {.setup = &s, .responses = {response, failure_response},
        .count = response == GTK_RESPONSE_YES && !launch_ok ? 2 : 1, .launch_ok = launch_ok};
    active_prompt = &probe;
    guint timer = running ? 0 : g_timeout_add(60, answer_prompt, &probe);
    gboolean proceed = prompt_for_steam(&s, running, fake_start);
    if (timer) g_source_remove(timer);
    gboolean expected = running || response == GTK_RESPONSE_NO ||
        (response == GTK_RESPONSE_YES && (launch_ok || failure_response == GTK_RESPONSE_NO));
    g_assert_cmpint(proceed, ==, expected);
    g_assert_cmpint(g_cancellable_is_cancelled(s.cancel), ==, !expected);
    g_assert_cmpint(probe.launches, ==, !running && response == GTK_RESPONSE_YES ? 1 : 0);
    g_assert_cmpint(probe.seen, ==, running ? 0 : probe.count);
    g_print("{\"prompt_running\":%s,\"response\":%d,\"launch_ok\":%s,\"dialogs_answered\":%d,\"steam_launches_mocked\":%d,\"proceed\":%s}\n",
            running ? "true" : "false", response, launch_ok ? "true" : "false",
            probe.seen, probe.launches, proceed ? "true" : "false");
    active_prompt = NULL;
    gtk_widget_destroy(s.window);
    g_object_unref(s.cancel);
}

static void settle_window(Setup *s)
{
    gint64 deadline = g_get_monotonic_time() + 5 * G_TIME_SPAN_SECOND;
    do {
        while (gtk_events_pending()) gtk_main_iteration();
        GdkWindow *window = gtk_widget_get_window(s->window);
        if (window && (gdk_window_get_state(window) & GDK_WINDOW_STATE_MAXIMIZED) &&
            !(gdk_window_get_state(window) & GDK_WINDOW_STATE_FULLSCREEN)) {
            GdkMonitor *monitor = gdk_display_get_monitor_at_window(gdk_window_get_display(window), window);
            GdkRectangle workarea, frame;
            int client_x, client_y;
            gdk_monitor_get_workarea(monitor, &workarea);
            gdk_window_get_frame_extents(window, &frame);
            gdk_window_get_origin(window, &client_x, &client_y);
            if (frame.x == workarea.x && frame.y == workarea.y &&
                frame.width == workarea.width && frame.height == workarea.height &&
                client_y > frame.y) return;
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
        g_printerr("Maximized diagnostic: display=%s state=0x%x gtk_size=%dx%d gdk_geometry=%d,%d %dx%d allocation=%d,%d %dx%d monitor=%d,%d %dx%d border=%u\n",
                   gdk_display_get_name(display), (unsigned)gdk_window_get_state(window),
                   width, height, x, y, gdk_width, gdk_height,
                   allocation.x, allocation.y, allocation.width, allocation.height,
                   bounds.x, bounds.y, bounds.width, bounds.height,
                   gtk_container_get_border_width(GTK_CONTAINER(s->window)));
        GdkRectangle workarea, frame;
        int client_x, client_y;
        gdk_monitor_get_workarea(monitor, &workarea);
        gdk_window_get_frame_extents(window, &frame);
        gdk_window_get_origin(window, &client_x, &client_y);
        g_printerr("Maximized frame: %d,%d %dx%d workarea=%d,%d %dx%d client_origin=%d,%d decorated=%d\n",
                   frame.x, frame.y, frame.width, frame.height, workarea.x, workarea.y,
                   workarea.width, workarea.height, client_x, client_y, gtk_window_get_decorated(GTK_WINDOW(s->window)));
        if (GDK_IS_X11_DISPLAY(display) && !g_strcmp0(gdk_display_get_name(display), g_getenv("DISPLAY"))) {
            char *xid = g_strdup_printf("0x%lx", gdk_x11_window_get_xid(window));
            char *root_args[] = {"xprop", "-root", "_NET_SUPPORTING_WM_CHECK", "_NET_SUPPORTED",
                "_NET_CLIENT_LIST", "_NET_ACTIVE_WINDOW", NULL};
            char *client_args[] = {"xprop", "-id", xid, "_NET_WM_STATE", "WM_STATE",
                "WM_NORMAL_HINTS", "_NET_WM_WINDOW_TYPE", "_NET_FRAME_EXTENTS", NULL};
            char *tree_args[] = {"xwininfo", "-root", "-tree", NULL};
            x11_diagnostic(root_args);
            x11_diagnostic(client_args);
            x11_diagnostic(tree_args);
            g_free(xid);
        }
    } else g_printerr("Maximized diagnostic: no realized GdkWindow\n");
    g_error("The private window manager did not maximize the decorated window within five seconds.");
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
    GdkRectangle workarea, frame;
    int client_x, client_y;
    gdk_monitor_get_workarea(monitor, &workarea);
    gdk_window_get_frame_extents(window, &frame);
    gdk_window_get_origin(window, &client_x, &client_y);
    g_assert_true((gdk_window_get_state(window) & GDK_WINDOW_STATE_MAXIMIZED) != 0);
    g_assert_false((gdk_window_get_state(window) & GDK_WINDOW_STATE_FULLSCREEN) != 0);
    g_assert_true(gtk_window_get_decorated(GTK_WINDOW(s.window)));
    g_assert_cmpint(frame.x, ==, workarea.x);
    g_assert_cmpint(frame.y, ==, workarea.y);
    g_assert_cmpint(frame.width, ==, workarea.width);
    g_assert_cmpint(frame.height, ==, workarea.height);
    g_assert_cmpint(client_y, >, frame.y);
    g_assert_cmpint(client_x, >=, frame.x);
    g_assert_cmpint(client_x + width, <=, frame.x + frame.width);
    g_assert_cmpint(client_y + height, <=, frame.y + frame.height);
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
    g_print("{\"steam_detected\":%s,\"maximized\":true,\"fullscreen\":false,\"titlebar_preserved\":true,\"client_width\":%d,\"client_height\":%d,\"warning_visible\":%s,\"progress_continues\":true,\"cancel_works\":true}\n",
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
        prompt_test(TRUE, GTK_RESPONSE_YES, TRUE, GTK_RESPONSE_CANCEL);
        prompt_test(FALSE, GTK_RESPONSE_NO, TRUE, GTK_RESPONSE_CANCEL);
        prompt_test(FALSE, GTK_RESPONSE_CANCEL, TRUE, GTK_RESPONSE_CANCEL);
        prompt_test(FALSE, GTK_RESPONSE_DELETE_EVENT, TRUE, GTK_RESPONSE_CANCEL);
        prompt_test(FALSE, GTK_RESPONSE_YES, TRUE, GTK_RESPONSE_CANCEL);
        prompt_test(FALSE, GTK_RESPONSE_YES, FALSE, GTK_RESPONSE_NO);
        prompt_test(FALSE, GTK_RESPONSE_YES, FALSE, GTK_RESPONSE_CANCEL);
        window_test(FALSE);
        window_test(TRUE);
    } else if (argc != 1) return 2;
    return 0;
}
