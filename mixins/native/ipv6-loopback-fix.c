/*
 * LD_PRELOAD fix for the emulator's cellular modem inside Docker.
 *
 * The emulator connects QEMU's "modem" chardev to its modem simulator at
 * host=::1 with getaddrinfo(AI_ADDRCONFIG). AI_ADDRCONFIG drops IPv6 results
 * when no non-loopback interface has an IPv6 address. Docker disables IPv6 on
 * eth0 by default, so the lookup fails ("address resolution failed for ::1"),
 * the modem is never connected and the radio never powers on: no SMS, no calls.
 *
 * This wrapper clears AI_ADDRCONFIG only for the IPv6 loopback literal "::1",
 * which is always reachable. Every other lookup goes through unchanged.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <string.h>

typedef int (*getaddrinfo_fn)(const char *, const char *,
                              const struct addrinfo *, struct addrinfo **);

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    static getaddrinfo_fn real;
    if (!real)
        real = (getaddrinfo_fn)dlsym(RTLD_NEXT, "getaddrinfo");

    if (node && hints && (hints->ai_flags & AI_ADDRCONFIG) && strcmp(node, "::1") == 0) {
        struct addrinfo h = *hints;
        h.ai_flags &= ~AI_ADDRCONFIG;
        return real(node, service, &h, res);
    }
    return real(node, service, hints, res);
}
