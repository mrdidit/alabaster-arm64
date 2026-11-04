#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

static void fail(const char *message)
{
    fprintf(stderr, "Alabaster Dawn: %s: %s\n", message, strerror(errno));
    exit(EXIT_FAILURE);
}

static char *format(const char *pattern, ...)
{
    char *result = NULL;
    va_list args;
    va_start(args, pattern);
    int length = vasprintf(&result, pattern, args);
    va_end(args);
    if (length < 0)
        fail("allocate launcher paths");
    return result;
}

static void make_directory(const char *path)
{
    if (mkdir(path, 0700) != 0 && errno != EEXIST)
        fail(path);
    struct stat status;
    if (stat(path, &status) != 0)
        fail(path);
    if (!S_ISDIR(status.st_mode)) {
        errno = ENOTDIR;
        fail(path);
    }
}

static void redirect_fd(const char *path, int flags, int destination)
{
    int descriptor = open(path, flags, 0600);
    if (descriptor < 0 || dup2(descriptor, destination) < 0)
        fail(path);
    if (descriptor != destination)
        close(descriptor);
}

int main(int argc, char **argv)
{
    char executable[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (length < 0)
        fail("resolve launcher location");
    if ((size_t)length >= sizeof(executable) - 1) {
        errno = ENAMETOOLONG;
        fail("resolve launcher location");
    }
    executable[length] = '\0';
    char *slash = strrchr(executable, '/');
    if (!slash) {
        errno = EINVAL;
        fail("resolve launcher directory");
    }
    *slash = '\0';
    const char *root = executable;
    char *runtime = format("%s/runtime/nwjs-v0.119.2-linux-arm64/nw", root);
    char *app = format("%s/app", root);
    char *profile = format("%s/profile", root);
    char *logs = format("%s/logs", root);
    char *pid_path = format("%s/latest.pid", logs);
    if (access(runtime, X_OK) != 0)
        fail(runtime);
    if (access(format("%s/package.json", app), R_OK) != 0)
        fail("read app/package.json");
    char *font_config = format("%s/menu/assets/fonts/fonts.conf", app);
    if (access(font_config, R_OK) != 0)
        fail("read bundled font configuration");
    if (setenv("FONTCONFIG_FILE", font_config, 1) != 0)
        fail("set bundled font configuration");

    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        printf("Native ARM64 launcher\nRuntime: %s\nApp: %s\nProfile: %s\n",
               runtime, app, profile);
        return EXIT_SUCCESS;
    }
    const char *display = getenv("DISPLAY");
    if (!display || !*display) {
        fputs("Alabaster Dawn: start from Steam or the desktop (X11/Xwayland display required).\n", stderr);
        return EXIT_FAILURE;
    }

    FILE *previous = fopen(pid_path, "r");
    if (previous) {
        long pid = 0;
        if (fscanf(previous, "%ld", &pid) == 1 && pid > 1 && pid <= INT_MAX) {
            char *old_exe = realpath(format("/proc/%ld/exe", pid), NULL);
            char *expected = realpath(runtime, NULL);
            bool running = old_exe && expected && strcmp(old_exe, expected) == 0;
            free(old_exe);
            free(expected);
            if (running) {
                fprintf(stderr, "Alabaster Dawn: already running (PID %ld).\n", pid);
                fclose(previous);
                return EXIT_FAILURE;
            }
        }
        fclose(previous);
    }

    make_directory(logs);
    make_directory(profile);
    time_t now = time(NULL);
    struct tm utc;
    char stamp[32];
    if (!gmtime_r(&now, &utc) || !strftime(stamp, sizeof(stamp), "%Y%m%dT%H%M%SZ", &utc)) {
        errno = EINVAL;
        fail("format launch time");
    }
    char *log = format("%s/%s-%ld.log", logs, stamp, (long)getpid());
    char *telemetry = format("%s/%s-%ld-telemetry.jsonl", logs, stamp, (long)getpid());
    if (setenv("ALABASTER_TEST_LOG", telemetry, 1) != 0)
        fail("set diagnostic path");
    struct rlimit core_limit = {0, 0};
    if (setrlimit(RLIMIT_CORE, &core_limit) != 0)
        fail("disable core dumps");

    char **command = calloc((size_t)argc + 7, sizeof(*command));
    if (!command)
        fail("allocate runtime arguments");
    int count = 0;
    command[count++] = runtime;
    command[count++] = format("--user-data-dir=%s", profile);
    command[count++] = "--ozone-platform=x11";
    command[count++] = "--enable-logging=stderr";
    command[count++] = "--log-level=1";
    for (int index = 1; index < argc; ++index)
        command[count++] = argv[index];
    command[count++] = app;
    command[count] = NULL;

    FILE *pid_file = fopen(pid_path, "w");
    if (!pid_file)
        fail(pid_path);
    int written = fprintf(pid_file, "%ld\n", (long)getpid());
    int closed = fclose(pid_file);
    if (written < 0 || closed != 0)
        fail("write launcher PID");
    if (chdir(app) != 0)
        fail(app);
    redirect_fd("/dev/null", O_RDONLY, STDIN_FILENO);
    redirect_fd(log, O_WRONLY | O_CREAT | O_APPEND, STDOUT_FILENO);
    if (dup2(STDOUT_FILENO, STDERR_FILENO) < 0)
        fail("redirect error log");
    fprintf(stderr, "Native launcher: pid=%ld pgrp=%ld session=%ld; exec %s\n",
            (long)getpid(), (long)getpgrp(), (long)getsid(0), runtime);
    fflush(stderr);
    signal(SIGPIPE, SIG_DFL);
#ifdef SIGXFSZ
    signal(SIGXFSZ, SIG_DFL);
#endif
    execv(runtime, command);
    fail("start NW.js");
}
