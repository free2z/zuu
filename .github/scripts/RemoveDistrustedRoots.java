import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;

/** Remove exact public roots affected by the eMudhra incident, before JVM clients start.
 * Java 17+, POSIX; use only a CA trust store with its standard changeit password.
 * Fingerprints: https://emudhra.we-have-a-problem.com/roots.json
 */
public class RemoveDistrustedRoots {
    private static final char[] PASSWORD = "changeit".toCharArray();
    private static final Set<String> BLOCKED = Set.of(
        "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D",
        "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5",
        "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4",
        "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B"
    );

    private static ArrayList<String> affected(KeyStore store) throws Exception {
        var result = new ArrayList<String>();
        var aliases = store.aliases();
        while (aliases.hasMoreElements()) {
            String alias = aliases.nextElement();
            var certificate = store.getCertificate(alias);
            if (certificate != null && BLOCKED.contains(HexFormat.of().withUpperCase().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded())))) {
                if (!store.isCertificateEntry(alias)) {
                    throw new IllegalStateException("Expected a CA certificate entry");
                }
                result.add(alias);
            }
        }
        return result;
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Expected one CA trust-store path");
        Path path = Path.of(args[0]).toRealPath();
        byte[] original = Files.readAllBytes(path);
        KeyStore store = KeyStore.getInstance(path.toFile(), PASSWORD);
        store.load(new ByteArrayInputStream(original), PASSWORD);
        var removed = affected(store);
        if (removed.isEmpty()) {
            if (store.size() == 0) throw new IllegalStateException("CA trust store is empty");
            System.out.println("Java trust: affected roots absent; store unchanged");
            return;
        }
        for (String alias : removed) store.deleteEntry(alias);
        if (store.size() == 0) throw new IllegalStateException("Refusing an empty replacement trust store");
        var bytes = new ByteArrayOutputStream();
        store.store(bytes, PASSWORD);
        store.load(new ByteArrayInputStream(bytes.toByteArray()), PASSWORD);
        if (!affected(store).isEmpty()) throw new IllegalStateException("Distrusted roots remain");

        var attributes = Files.readAttributes(path, PosixFileAttributes.class);
        Path backup = path.resolveSibling(path.getFileName() + ".before-emudhra");
        if (!Files.exists(backup, LinkOption.NOFOLLOW_LINKS)) {
            Files.copy(path, backup, StandardCopyOption.COPY_ATTRIBUTES);
        } else if (!Files.isRegularFile(backup, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalStateException("CA backup must be a regular file");
        }
        Path temporary = Files.createTempFile(path.getParent(), ".java-trust-", ".tmp");
        try {
            Files.write(temporary, bytes.toByteArray());
            Files.setPosixFilePermissions(temporary, attributes.permissions());
            Files.setOwner(temporary, attributes.owner());
            Files.setAttribute(temporary, "posix:group", attributes.group());
            if (!Arrays.equals(original, Files.readAllBytes(path))) {
                throw new IllegalStateException("CA trust store changed during repair");
            }
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
        System.out.println("Java trust: removed " + removed.size() + " affected roots; retained " + store.size());
    }
}
