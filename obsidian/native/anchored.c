// Darwin filesystem primitives unavailable in node:fs. Every name is one directory entry;
// directory descriptors are owned by the caller. This module never accepts an absolute path.
#define NAPI_VERSION 8
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct { int fd; char name[NAME_MAX + 1]; } entry;

static napi_value failure(napi_env env, int e) {
    const char *code = e == ENOENT ? "ENOENT" : e == EEXIST ? "EEXIST" :
        e == ENOTDIR ? "ENOTDIR" : e == ELOOP ? "ELOOP" : "EIO";
    napi_throw_error(env, code, strerror(e));
    return NULL;
}

static int integer(napi_env env, napi_value v) {
    int32_t n = -1;
    if (napi_get_value_int32(env, v, &n) != napi_ok) return -1;
    return n;
}

static int component(napi_env env, napi_value fd, napi_value name, entry *out) {
    size_t size = 0;
    out->fd = integer(env, fd);
    if (out->fd < 0 || napi_get_value_string_utf8(env, name, NULL, 0, &size) != napi_ok ||
        size == 0 || size > NAME_MAX ||
        napi_get_value_string_utf8(env, name, out->name, sizeof(out->name), &size) != napi_ok) return -1;
    return strlen(out->name) == size && !strchr(out->name, '/') &&
        strcmp(out->name, ".") && strcmp(out->name, "..") ? 0 : -1;
}

static napi_value result(napi_env env, int value) {
    if (value < 0) return failure(env, errno);
    napi_value out;
    napi_create_int32(env, value, &out);
    return out;
}

static napi_value open_entry(napi_env env, napi_callback_info info) {
    size_t n = 4;
    napi_value a[4];
    entry p;
    napi_get_cb_info(env, info, &n, a, NULL, NULL);
    if (n != 4 || component(env, a[0], a[1], &p)) return failure(env, EINVAL);
    const int flags = integer(env, a[2]), mode = integer(env, a[3]);
    return result(env, openat(p.fd, p.name, flags | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode));
}

static napi_value make_directory(napi_env env, napi_callback_info info) {
    size_t n = 2;
    napi_value a[2];
    entry p;
    napi_get_cb_info(env, info, &n, a, NULL, NULL);
    if (n != 2 || component(env, a[0], a[1], &p)) return failure(env, EINVAL);
    return result(env, mkdirat(p.fd, p.name, 0700));
}

static napi_value rename_entry(napi_env env, napi_callback_info info) {
    size_t n = 5;
    napi_value a[5];
    entry from, to;
    napi_get_cb_info(env, info, &n, a, NULL, NULL);
    if (n != 5 || component(env, a[0], a[1], &from) || component(env, a[2], a[3], &to)) return failure(env, EINVAL);
    const int flag = integer(env, a[4]);
    if (flag != RENAME_SWAP && flag != RENAME_EXCL) return failure(env, EINVAL);
    return result(env, renameatx_np(from.fd, from.name, to.fd, to.name, (unsigned)flag));
}

// Ask the filesystem watcher to observe an already published inode. Preserve modification time.
static napi_value announce_entry(napi_env env, napi_callback_info info) {
    size_t n = 1;
    napi_value a[1];
    napi_get_cb_info(env, info, &n, a, NULL, NULL);
    if (n != 1) return failure(env, EINVAL);
    const struct timespec times[2] = {{0, UTIME_NOW}, {0, UTIME_OMIT}};
    return result(env, futimens(integer(env, a[0]), times));
}

static napi_value list_entries(napi_env env, napi_callback_info info) {
    size_t n = 1;
    napi_value a[1], out;
    napi_get_cb_info(env, info, &n, a, NULL, NULL);
    if (n != 1) return failure(env, EINVAL);
    int fd = openat(integer(env, a[0]), ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return failure(env, errno);
    DIR *dir = fdopendir(fd);
    if (!dir) { int e = errno; close(fd); return failure(env, e); }
    napi_create_array(env, &out);
    uint32_t index = 0;
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *d = readdir(dir);
        if (!d) { error = errno; break; }
        if (!strcmp(d->d_name, ".") || !strcmp(d->d_name, "..")) continue;
        napi_value name;
        napi_create_string_utf8(env, d->d_name, NAPI_AUTO_LENGTH, &name);
        napi_set_element(env, out, index++, name);
    }
    closedir(dir);
    return error ? failure(env, error) : out;
}

static napi_value initialize(napi_env env, napi_value exports) {
    const napi_property_descriptor methods[] = {
        {"open", NULL, open_entry, NULL, NULL, NULL, napi_default, NULL},
        {"mkdir", NULL, make_directory, NULL, NULL, NULL, napi_default, NULL},
        {"rename", NULL, rename_entry, NULL, NULL, NULL, napi_default, NULL},
        {"announce", NULL, announce_entry, NULL, NULL, NULL, napi_default, NULL},
        {"list", NULL, list_entries, NULL, NULL, NULL, napi_default, NULL},
    };
    napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
    return exports;
}
NAPI_MODULE(anchored_files, initialize)
