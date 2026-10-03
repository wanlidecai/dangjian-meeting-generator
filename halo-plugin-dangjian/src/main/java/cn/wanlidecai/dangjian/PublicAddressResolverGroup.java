package cn.wanlidecai.dangjian;

import io.netty.resolver.AbstractAddressResolver;
import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.resolver.ResolvedAddressTypes;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Future;
import io.netty.util.concurrent.Promise;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import reactor.netty.http.HttpResources;
import reactor.netty.transport.NameResolverProvider;

/**
 * Checks the actual asynchronous DNS answers used by Netty's connection attempt.
 * URI hostnames remain untouched, preserving HTTP Host and TLS SNI.
 */
public final class PublicAddressResolverGroup extends AddressResolverGroup<InetSocketAddress> {
    private final AddressResolverGroup<InetSocketAddress> delegateGroup;

    public PublicAddressResolverGroup() {
        // Reactor chooses a DNS channel compatible with its native/NIO event loops.
        this(NameResolverProvider.builder()
            .resolvedAddressTypes(ResolvedAddressTypes.IPV4_PREFERRED)
            .completeOncePreferredResolved(false)
            .queryTimeout(Duration.ofSeconds(4))
            .cacheMaxTimeToLive(Duration.ofSeconds(60))
            .build().newNameResolverGroup(HttpResources.get(), true));
    }

    PublicAddressResolverGroup(AddressResolverGroup<InetSocketAddress> delegateGroup) {
        this.delegateGroup = Objects.requireNonNull(delegateGroup, "delegateGroup");
    }

    @Override
    protected AddressResolver<InetSocketAddress> newResolver(EventExecutor executor) {
        return new GuardedResolver(executor, delegateGroup.getResolver(executor));
    }

    @Override
    public void close() {
        try {
            super.close();
        } finally {
            delegateGroup.close();
        }
    }

    private static final class GuardedResolver extends AbstractAddressResolver<InetSocketAddress> {
        private final AddressResolver<InetSocketAddress> delegate;

        private GuardedResolver(EventExecutor executor, AddressResolver<InetSocketAddress> delegate) {
            super(executor, InetSocketAddress.class);
            this.delegate = delegate;
        }

        @Override
        protected boolean doIsResolved(InetSocketAddress address) {
            // Netty otherwise skips doResolve for literals and pre-resolved addresses.
            return false;
        }

        @Override
        protected void doResolve(InetSocketAddress address, Promise<InetSocketAddress> promise) {
            Promise<List<InetSocketAddress>> all = executor().newPromise();
            all.addListener(ignored -> {
                if (all.isSuccess()) {
                    promise.trySuccess(all.getNow().getFirst());
                } else {
                    promise.tryFailure(all.cause());
                }
            });
            resolveChecked(address, all);
        }

        @Override
        protected void doResolveAll(InetSocketAddress address, Promise<List<InetSocketAddress>> promise) {
            resolveChecked(address, promise);
        }

        private void resolveChecked(InetSocketAddress address, Promise<List<InetSocketAddress>> promise) {
            if (!address.isUnresolved()) {
                completeChecked(List.of(address), promise);
                return;
            }
            // Even resolve(single) checks every A/AAAA answer before choosing an address.
            Future<List<InetSocketAddress>> resolving = delegate.resolveAll(address);
            resolving.addListener(ignored -> {
                if (resolving.isSuccess()) {
                    completeChecked(resolving.getNow(), promise);
                } else {
                    promise.tryFailure(resolving.cause());
                }
            });
        }

        private static void completeChecked(List<InetSocketAddress> addresses,
                                             Promise<List<InetSocketAddress>> promise) {
            if (addresses == null || addresses.isEmpty() || addresses.stream().anyMatch(address ->
                address == null || address.isUnresolved() || blockedAddress(address.getAddress()))) {
                promise.tryFailure(new UnknownHostException("参考材料目标不是可访问的公网地址。"));
                return;
            }
            // These are the checked addresses that TransportConnector connects to; no second DNS.
            promise.trySuccess(List.copyOf(addresses));
        }
    }

    /** Conservative public-unicast policy for source retrieval, including special-purpose ranges. */
    public static boolean blockedAddress(InetAddress address) {
        if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress()
            || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            int third = bytes[2] & 0xff;
            return first == 0 || first == 10 || first == 127 || first >= 224
                || (first == 100 && second >= 64 && second <= 127)
                || (first == 169 && second == 254)
                || (first == 172 && second >= 16 && second <= 31)
                || (first == 192 && second == 168)
                || (first == 192 && second == 0 && (third == 0 || third == 2))
                || (first == 192 && second == 88 && third == 99)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113);
        }
        if (bytes.length == 16) {
            // Only 2000::/3 is global unicast; reject mapped/NAT64/ULA/scoped/reserved space.
            if ((bytes[0] & 0xe0) != 0x20) {
                return true;
            }
            int first16 = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff);
            int second16 = ((bytes[2] & 0xff) << 8) | (bytes[3] & 0xff);
            return (first16 == 0x2001 && second16 < 0x0200) // IETF special assignments /23
                || (first16 == 0x2001 && second16 == 0x0db8) // documentation /32
                || first16 == 0x2002 // 6to4: embedded IPv4 could point to private networks
                || first16 == 0x3ffe // deprecated 6bone allocation
                || (first16 == 0x3fff && (second16 & 0xf000) == 0); // documentation /20
        }
        return true;
    }
}
