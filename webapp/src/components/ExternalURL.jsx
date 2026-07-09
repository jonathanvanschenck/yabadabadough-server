
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

export default function ExternalURL({ text, href, ...rest }) {
   return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
            {text || "External Link"} <FontAwesomeIcon icon="fa-solid fa-arrow-up-right-from-square" />
        </a>
    );
}
