/**
 * Native Messaging Host wrapper for macOS.
 *
 * macOS blocks Chrome from executing script files (.sh, .py) directly.
 * This compiled Mach-O binary acts as a thin launcher that exec's Python
 * with the convert_and_save.py script, which Chrome can launch without issue.
 *
 * Build:  cc -o native_host native_host.c
 * Sign:   codesign -s - native_host
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <mach-o/dyld.h>

int main(int argc, char *argv[]) {
    /* Resolve directory of this binary */
    char self[1024];
    uint32_t size = sizeof(self);
    _NSGetExecutablePath(self, &size);

    char resolved[1024];
    realpath(self, resolved);

    char *last_slash = strrchr(resolved, '/');
    if (last_slash) *last_slash = '\0';

    /* Build paths */
    char script[2048];
    char logpath[2048];
    snprintf(script,  sizeof(script),  "%s/convert_and_save.py", resolved);
    snprintf(logpath, sizeof(logpath), "%s/debug.log",           resolved);

    /* Redirect stderr to debug.log */
    FILE *logf = fopen(logpath, "a");
    if (logf) {
        dup2(fileno(logf), STDERR_FILENO);
        fclose(logf);
    }

    /* Ensure a sane PATH */
    setenv("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", 1);

    /* exec Python with the host script */
    execl("/usr/bin/python3", "python3", script, NULL);

    /* If exec fails, log and exit */
    logf = fopen(logpath, "a");
    if (logf) {
        fprintf(logf, "[WRAPPER] execl failed\n");
        fclose(logf);
    }
    return 1;
}
