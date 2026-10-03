package cn.wanlidecai.dangjian;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.netty.resolver.AbstractAddressResolver;
import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.util.concurrent.DefaultEventExecutor;
import io.netty.util.concurrent.EventExecutor;
import io.netty.util.concurrent.Future;
import io.netty.util.concurrent.Promise;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class PublicAddressResolverGroupTest {
    private final DefaultEventExecutor executor = new DefaultEventExecutor();
    private PublicAddressResolverGroup group;

    @AfterEach
    void closeResources() {
        if (group != null) {
            group.close();
        }
        executor.shutdownGracefully(0, 0, TimeUnit.MILLISECONDS).syncUninterruptibly();
    }

    private AddressResolver<InetSocketAddress> resolver(FakeGroup fake) {
        group = new PublicAddressResolverGroup(fake);
        return group.getResolver(executor);
    }

    private InetSocketAddress ipv4(String host, int a, int b, int c, int d) throws Exception {
        return new InetSocketAddress(InetAddress.getByAddress(host,
            new byte[]{(byte) a, (byte) b, (byte) c, (byte) d}), 443);
    }

    private <T> T success(Future<T> future) {
        assertTrue(future.awaitUninterruptibly(2, TimeUnit.SECONDS), "DNS future did not complete");
        assertTrue(future.isSuccess(), String.valueOf(future.cause()));
        return future.getNow();
    }

    private void denied(Future<?> future) {
        assertTrue(future.awaitUninterruptibly(2, TimeUnit.SECONDS), "DNS future did not complete");
        assertFalse(future.isSuccess());
        assertTrue(future.cause() instanceof UnknownHostException);
    }

    @Test
    void resolveAndResolveAllPreserveCheckedPublicAddressesAndHostnames() throws Exception {
        var first = ipv4("www.people.com.cn", 8, 8, 8, 8);
        var second = ipv4("www.people.com.cn", 1, 1, 1, 1);
        var fake = new FakeGroup(List.of(first, second), null);
        var resolver = resolver(fake);
        var input = InetSocketAddress.createUnresolved("www.people.com.cn", 443);
        assertSame(first, success(resolver.resolve(input)));
        assertEquals(List.of(first, second), success(resolver.resolveAll(input)));
        assertEquals("www.people.com.cn", success(resolver.resolve(input)).getHostString());
        assertEquals(3, fake.allCalls.get());
        assertEquals(0, fake.singleCalls.get());
    }

    @Test
    void privateSecondaryAnswerRejectsBothSingleAndAllResolution() throws Exception {
        var fake = new FakeGroup(List.of(ipv4("www.people.com.cn", 8, 8, 8, 8),
            ipv4("www.people.com.cn", 10, 0, 0, 1)), null);
        var resolver = resolver(fake);
        var input = InetSocketAddress.createUnresolved("www.people.com.cn", 443);
        denied(resolver.resolve(input));
        denied(resolver.resolveAll(input));
        assertEquals(2, fake.allCalls.get());
        assertEquals(0, fake.singleCalls.get());
    }

    @Test
    void privateIpv6SecondaryAnswerRejectsPublicIpv4Result() throws Exception {
        var ula = new InetSocketAddress(InetAddress.getByName("fd00::1"), 443);
        var resolver = resolver(new FakeGroup(List.of(ipv4("www.people.com.cn", 8, 8, 8, 8), ula), null));
        denied(resolver.resolve(InetSocketAddress.createUnresolved("www.people.com.cn", 443)));
    }

    @Test
    void preResolvedPrivateAddressesCannotBypassGuard() throws Exception {
        var fake = new FakeGroup(List.of(ipv4("unused.invalid", 8, 8, 8, 8)), null);
        var resolver = resolver(fake);
        var privateAddress = ipv4("www.people.com.cn", 127, 0, 0, 1);
        assertFalse(resolver.isResolved(privateAddress));
        denied(resolver.resolve(privateAddress));
        denied(resolver.resolveAll(privateAddress));
        assertEquals(0, fake.allCalls.get());
    }

    @Test
    void preResolvedPublicAddressPassesWithoutAnyNewDnsLookup() throws Exception {
        var fake = new FakeGroup(List.of(), null);
        var resolver = resolver(fake);
        var publicAddress = ipv4("www.people.com.cn", 1, 1, 1, 1);
        assertFalse(resolver.isResolved(publicAddress));
        assertSame(publicAddress, success(resolver.resolve(publicAddress)));
        assertEquals(List.of(publicAddress), success(resolver.resolveAll(publicAddress)));
        assertEquals(0, fake.allCalls.get());
    }

    @Test
    void dnsFailuresAndEmptyAnswersNeverYieldConnectionAddresses() {
        var failure = new UnknownHostException("DNS unavailable");
        var resolver = resolver(new FakeGroup(List.of(), failure));
        var input = InetSocketAddress.createUnresolved("www.people.com.cn", 443);
        var future = resolver.resolve(input);
        denied(future);
        assertSame(failure, future.cause());
        group.close();
        resolver = resolver(new FakeGroup(List.of(), null));
        denied(resolver.resolveAll(input));
    }

    @Test
    void unresolvedDelegateAnswerIsRejectedRatherThanTriggeringAnotherDnsLookup() {
        var resolver = resolver(new FakeGroup(List.of(InetSocketAddress.createUnresolved("private.invalid", 443)), null));
        denied(resolver.resolveAll(InetSocketAddress.createUnresolved("www.people.com.cn", 443)));
    }

    @Test
    void allIpv4NonPublicAndSpecialPurposeBoundariesAreRejected() throws Exception {
        for (String text : List.of("0.0.0.1", "10.255.255.255", "100.64.0.0", "100.127.255.255",
            "127.255.255.255", "169.254.0.1", "172.16.0.0", "172.31.255.255", "192.168.1.1",
            "192.0.0.9", "192.0.2.1", "192.88.99.1", "198.18.0.0", "198.19.255.255",
            "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1",
            "255.255.255.255")) {
            assertTrue(PublicAddressResolverGroup.blockedAddress(InetAddress.getByName(text)), text);
        }
        for (String text : List.of("8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.0",
            "172.15.255.255", "172.32.0.0", "198.17.255.255", "198.20.0.0")) {
            assertFalse(PublicAddressResolverGroup.blockedAddress(InetAddress.getByName(text)), text);
        }
    }

    @Test
    void ipv6MappedLocalUlaDocumentationTransitionAndReservedRangesAreRejected() throws Exception {
        for (String text : List.of("::", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1",
            "64:ff9b:1::1", "100::1", "fc00::1", "fdff::1", "fe80::1", "fec0::1", "ff02::1",
            "2001::1", "2001:2::1", "2001:db8::1", "2002:7f00:1::1", "3ffe::1", "3fff::1",
            "3fff:fff::1", "5f00::1")) {
            assertTrue(PublicAddressResolverGroup.blockedAddress(InetAddress.getByName(text)), text);
        }
        for (String text : List.of("2606:4700:4700::1111", "2001:4860:4860::8888", "2400:3200::1")) {
            assertFalse(PublicAddressResolverGroup.blockedAddress(InetAddress.getByName(text)), text);
        }
    }

    private static final class FakeGroup extends AddressResolverGroup<InetSocketAddress> {
        private final List<InetSocketAddress> addresses;
        private final Throwable failure;
        private final AtomicInteger allCalls = new AtomicInteger();
        private final AtomicInteger singleCalls = new AtomicInteger();

        private FakeGroup(List<InetSocketAddress> addresses, Throwable failure) {
            this.addresses = addresses;
            this.failure = failure;
        }

        @Override
        protected AddressResolver<InetSocketAddress> newResolver(EventExecutor executor) {
            return new AbstractAddressResolver<>(executor, InetSocketAddress.class) {
                @Override
                protected boolean doIsResolved(InetSocketAddress address) {
                    return !address.isUnresolved();
                }

                @Override
                protected void doResolve(InetSocketAddress address, Promise<InetSocketAddress> promise) {
                    singleCalls.incrementAndGet();
                    promise.setFailure(new AssertionError("The guard must check all answers, including resolve(single)."));
                }

                @Override
                protected void doResolveAll(InetSocketAddress address, Promise<List<InetSocketAddress>> promise) {
                    allCalls.incrementAndGet();
                    if (failure != null) {
                        promise.setFailure(failure);
                    } else {
                        promise.setSuccess(addresses);
                    }
                }
            };
        }
    }
}
